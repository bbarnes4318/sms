const db = require('./database');
const EventEmitter = require('events');
const { Pacer, BLOCK } = require('./pacing');

let fractelToken = null;
let fractelTokenExpiresAt = 0;

// Fetch with timeout wrapper using AbortController
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Errors that will never succeed on a retry. Retrying a missing password
 * three times with backoff just delays the failure and floods the log.
 */
function isPermanentError(err) {
  return /not configured|Invalid credentials|401|403/i.test(err.message || '');
}

// SMS Send retry engine
async function sendSmsWithRetry(sendFn, maxRetries = 3, baseDelayMs = 2000) {
  let attempt = 0;
  while (true) {
    try {
      return await sendFn();
    } catch (err) {
      attempt++;
      if (isPermanentError(err)) {
        console.error(`SMS send abandoned (configuration error): ${err.message}`);
        throw err;
      }
      console.warn(`SMS Send Attempt ${attempt} failed: ${err.message}`);
      if (attempt >= maxRetries) {
        throw err;
      }
      const backoffDelay = baseDelayMs * attempt;
      console.log(`Retrying in ${backoffDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

async function getFractelToken(settings) {
  const username = settings.fractel_username || '';
  const password = settings.fractel_password || '';

  if (!username || !password) {
    throw new Error('FracTEL username or password is not configured.');
  }

  const now = Date.now();
  if (fractelToken && fractelTokenExpiresAt > now + 300000) {
    return fractelToken;
  }

  console.log('Fetching new FracTEL auth token...');
  const response = await fetchWithTimeout('https://api.fonestorm.com/v2/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: username,
      password: password,
      expires: 86400
    })
  }, 10000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FracTEL auth failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const token = data.auth && data.auth.token;
  if (!token) {
    throw new Error('No auth token returned in FracTEL response.');
  }

  fractelToken = token;
  fractelTokenExpiresAt = now + (86400 - 1800) * 1000;
  console.log('Successfully retrieved and cached FracTEL token.');
  return fractelToken;
}

/**
 * SMS queue worker.
 *
 * The previous worker was a strict serial loop: take the oldest queued message,
 * send it, sleep a fixed global interval, repeat. That paced the whole DID pool
 * as if it were a single number and produced a metronome-regular cadence.
 *
 * This worker instead asks the pacer, per message, whether that message's DID
 * may send right now. Messages whose DID is rate limited, capped, paused, or
 * whose recipient is outside their local daytime window are skipped rather than
 * blocking the queue behind them, and several DIDs send concurrently.
 *
 * When nothing at all is sendable, the worker sleeps until the soonest moment
 * something becomes eligible instead of polling.
 */
const IDLE_POLL_MS = 1000;        // nothing queued
const MAX_SLEEP_MS = 60000;       // re-check at least once a minute
const CANDIDATE_WINDOW = 200;     // messages examined per tick

class QueueWorker extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.timer = null;
    this.inFlight = new Set();
    this.ticking = false;
    this.pacer = new Pacer({
      getSettings: () => db.getSettings(),
      getDidSummary: () => db.getDidSendSummary()
    });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    // Anything still 'sending' belongs to a process that died mid-send. Surface
    // it rather than leaving it invisible in the queue forever.
    try {
      db.failStaleSendingMessages(15);
    } catch (err) {
      console.error('Could not reconcile interrupted sends:', err.message);
    }
    console.log('SMS Queue worker started (per-DID pacing).');
    this.tick();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('SMS Queue worker stopped.');
  }

  /** Public nudge used by the API when new work is queued. */
  processNext() {
    this.scheduleTick(0);
  }

  scheduleTick(delayMs) {
    if (!this.isRunning) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(MAX_SLEEP_MS, delayMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  /**
   * One scheduling pass: dispatch every message that is eligible right now, up
   * to the concurrency limit, then sleep until the next one becomes eligible.
   */
  tick() {
    if (!this.isRunning || this.ticking) return;
    this.ticking = true;

    try {
      const cfg = this.pacer.config();

      if (this.inFlight.size >= cfg.maxConcurrent) {
        // Every slot is busy; a completing send re-ticks. The timer is only a
        // backstop against a send that never settles.
        this.scheduleTick(MAX_SLEEP_MS);
        return;
      }

      let candidates;
      try {
        candidates = db.getDueQueuedMessages(CANDIDATE_WINDOW);
      } catch (err) {
        console.error('Queue worker could not read the queue:', err.message);
        this.scheduleTick(5000);
        return;
      }

      if (!candidates.length) {
        this.scheduleTick(IDLE_POLL_MS);
        return;
      }

      const now = new Date();
      let soonestRetryMs = Infinity;

      for (const msg of candidates) {
        if (this.inFlight.size >= cfg.maxConcurrent) break;
        if (this.inFlight.has(msg.id)) continue;

        const verdict = this.pacer.evaluate(msg, now);
        if (!verdict.ok) {
          if (verdict.retryInMs < soonestRetryMs) soonestRetryMs = verdict.retryInMs;
          continue;
        }

        // Last line of defence, checked only for a message about to go out: the
        // contact may have opted out after it was queued, or while it waited on
        // a future schedule. Running this for every candidate on every tick
        // would mean hundreds of suppression lookups a second for no gain.
        const block = db.cancelIfSuppressed(msg);
        if (block) {
          this.emit('messageStatusChanged', {
            id: msg.id,
            status: 'failed',
            error_message: `Blocked before send: ${block.label}`,
            conversation_id: msg.conversation_id
          });
          continue;
        }

        this.dispatch(msg);
      }

      // Wake for whichever comes first: the next gate lifting, or the periodic
      // backstop. A completing send also re-ticks immediately.
      const nextDelay = soonestRetryMs === Infinity
        ? (this.inFlight.size > 0 ? MAX_SLEEP_MS : IDLE_POLL_MS)
        // A small random offset so a batch released by the same gate (a daily
        // cap reset, a quiet-hours window opening) does not fire in lockstep.
        : soonestRetryMs + Math.floor(Math.random() * 1000);
      this.scheduleTick(nextDelay);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Claim and send one message. Claiming is a synchronous status write before
   * any await, so the same message cannot be picked up twice: better-sqlite3 is
   * synchronous and the candidate query only returns status='queued'.
   */
  dispatch(msg) {
    this.inFlight.add(msg.id);
    db.updateMessageStatus(msg.id, 'sending');
    this.emit('messageStatusChanged', {
      id: msg.id,
      status: 'sending',
      conversation_id: msg.conversation_id
    });

    // Reserve the DID's slot at dispatch time, not on completion. Reserving on
    // completion would let every concurrent slot claim the same DID while the
    // first send was still in flight, defeating the per-number gap entirely.
    this.pacer.recordSend(msg.from_number);

    this.send(msg)
      .catch(err => {
        console.error(`Queue worker error processing message ${msg.id}:`, err);
        try {
          db.updateMessageStatus(msg.id, 'failed', null, err.message || 'Internal error');
          this.emit('messageStatusChanged', {
            id: msg.id,
            status: 'failed',
            error_message: err.message || 'Internal error',
            conversation_id: msg.conversation_id
          });
        } catch (writeErr) {
          console.error('Could not record send failure:', writeErr.message);
        }
      })
      .finally(() => {
        this.inFlight.delete(msg.id);
        this.scheduleTick(0);
      });
  }

  async send(msg) {
    const settings = db.getSettings();

    // Normalize phone numbers for routing decision
    let cleanFrom = (msg.from_number || '').replace(/[^\d]/g, '');
    if (cleanFrom.length === 11 && cleanFrom.startsWith('1')) {
      cleanFrom = cleanFrom.substring(1);
    }

    const fractelDidsStr = settings.fractel_enabled_dids || '';
    const fractelDids = fractelDidsStr.split(',').map(d => {
      let cd = d.trim().replace(/[^\d]/g, '');
      if (cd.length === 11 && cd.startsWith('1')) {
        cd = cd.substring(1);
      }
      return cd;
    }).filter(Boolean);

    const isFractel = fractelDids.includes(cleanFrom) ||
                     (cleanFrom === (settings.fractel_sender_number || '').replace(/[^\d]/g, '').replace(/^1/, ''));

    let isSuccess = false;
    let refId = '';
    let errorMsg = '';
    let configError = false;

    if (isFractel) {
      // --- ROUTE VIA FRACTEL (FONESTORM) ---
      console.log(`Routing message ID ${msg.id} via FracTEL...`);

      const sendFn = async () => {
        const token = await getFractelToken(settings);
        const toNum = msg.to_number.replace(/[^\d]/g, '');

        const payload = {
          fonenumber: cleanFrom,
          to: [toNum],
          message: msg.body
        };

        // If there are media URLs, include them for MMS
        if (msg.media_urls) {
          try {
            const urls = JSON.parse(msg.media_urls);
            if (urls && urls.length > 0) {
              payload.media = urls[0];
            }
          } catch (e) {
            console.error("Failed to parse media URLs JSON:", e);
          }
        }

        const response = await fetchWithTimeout('https://api.fonestorm.com/v2/messages/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'token': token
          },
          body: JSON.stringify(payload)
        }, 10000);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Carrier HTTP ${response.status}: ${text}`);
        }

        const data = await response.json();
        console.log("FracTEL API response:", JSON.stringify(data));

        if (data.message && data.message.id) {
          return data.message.id;
        } else {
          throw new Error(data.message || 'Unknown response structure');
        }
      };

      try {
        refId = await sendSmsWithRetry(sendFn, 3, 2000);
        isSuccess = true;
      } catch (err) {
        console.error(`FracTEL sending failed for message ${msg.id}:`, err);
        errorMsg = err.message || "Failed to connect to FracTEL API";
        configError = isPermanentError(err);
      }
    } else {
      // --- ROUTE VIA BULKVS (DEFAULT) ---
      console.log(`Routing message ID ${msg.id} via BulkVS...`);

      const sendFn = async () => {
        const username = settings.bulkvs_username || '';
        const token = settings.bulkvs_token || '';
        const auth = Buffer.from(`${username}:${token}`).toString('base64');
        const authHeader = `Basic ${auth}`;

        const fromNum = cleanFrom || (settings.sender_number || '').replace(/[^\d]/g, '');
        const toNum = msg.to_number.replace(/[^\d]/g, '');

        const payload = {
          From: fromNum,
          To: [toNum],
          Message: msg.body
        };

        if (msg.media_urls) {
          try {
            payload.MediaURLs = JSON.parse(msg.media_urls);
          } catch (e) {
            console.error("Failed to parse media URLs JSON:", e);
          }
        }

        const response = await fetchWithTimeout('https://portal.bulkvs.com/api/v1.0/messageSend', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': authHeader
          },
          body: JSON.stringify(payload)
        }, 10000);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Carrier HTTP ${response.status}: ${text}`);
        }

        const data = await response.json();
        console.log("Bulkvs API response:", JSON.stringify(data));

        const ok = (
          (data.Results && data.Results[0] && data.Results[0].Status === 'SUCCESS') ||
          (data.RefId && !data.error && !data.message)
        );

        if (ok) {
          return data.RefId || (data.Results && data.Results[0] && data.Results[0].MessageId) || '';
        } else {
          const errStr = (data.Results && data.Results[0] && data.Results[0].Error) || data.message || 'API error';
          throw new Error(errStr);
        }
      };

      try {
        refId = await sendSmsWithRetry(sendFn, 3, 2000);
        isSuccess = true;
      } catch (err) {
        console.error(`BulkVS sending failed for message ${msg.id}:`, err);
        errorMsg = err.message || "Failed to connect to BulkVS API";
        configError = isPermanentError(err);
      }
    }

    // Feed the outcome back into pacing so a number the carrier has started
    // rejecting backs off instead of burning its reputation further. A
    // configuration error fails on every DID, so it must not pause one.
    if (!configError) {
      const paused = this.pacer.recordOutcome(msg.from_number, isSuccess);
      if (paused) this.emit('didPaused', paused);
    }

    if (isSuccess) {
      db.updateMessageStatus(msg.id, 'sent', refId);
      this.emit('messageStatusChanged', {
        id: msg.id,
        status: 'sent',
        ref_id: refId,
        conversation_id: msg.conversation_id
      });
    } else {
      db.updateMessageStatus(msg.id, 'failed', null, errorMsg);
      this.emit('messageStatusChanged', {
        id: msg.id,
        status: 'failed',
        error_message: errorMsg,
        conversation_id: msg.conversation_id
      });
    }
  }

  /** Per-DID pacing view for the status endpoint. */
  pacingStatus() {
    return {
      config: this.pacer.config(),
      in_flight: this.inFlight.size,
      dids: this.pacer.snapshot()
    };
  }

  /** Clear a failure-spike pause on one DID (operator override). */
  resumeDid(did) {
    const resumed = this.pacer.resume(did);
    if (resumed) this.processNext();
    return resumed;
  }

  /** Drop the cached settings after an update so changes take effect at once. */
  refreshConfig() {
    this.pacer.invalidateConfig();
    this.processNext();
  }
}

const worker = new QueueWorker();
module.exports = worker;
module.exports.BLOCK = BLOCK;
