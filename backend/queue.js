const db = require('./database');
const EventEmitter = require('events');

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

// SMS Send retry engine
async function sendSmsWithRetry(sendFn, maxRetries = 3, baseDelayMs = 2000) {
  let attempt = 0;
  while (true) {
    try {
      return await sendFn();
    } catch (err) {
      attempt++;
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

class QueueWorker extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.isProcessing = false; // Concurrency guard
    this.timer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("SMS Queue worker started.");
    this.processNext();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log("SMS Queue worker stopped.");
  }

  async processNext() {
    if (!this.isRunning) return;
    
    // Prevent multiple concurrent message processing threads
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;

    try {
      const msg = db.getNextQueuedMessage();
      if (!msg) {
        // No messages in queue, check again in 1 second
        this.timer = setTimeout(() => this.processNext(), 1000);
        this.isProcessing = false;
        return;
      }

      // Mark message as sending
      db.updateMessageStatus(msg.id, 'sending');
      this.emit('messageStatusChanged', { id: msg.id, status: 'sending', conversation_id: msg.conversation_id });

      // Get latest settings
      const settings = db.getSettings();
      const sendInterval = parseInt(settings.send_interval_ms, 10) || 2000;

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
          const resultRefId = await sendSmsWithRetry(sendFn, 3, 2000);
          isSuccess = true;
          refId = resultRefId;
        } catch (err) {
          console.error(`FracTEL sending failed for message ${msg.id}:`, err);
          errorMsg = err.message || "Failed to connect to FracTEL API";
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
          const resultRefId = await sendSmsWithRetry(sendFn, 3, 2000);
          isSuccess = true;
          refId = resultRefId;
        } catch (err) {
          console.error(`BulkVS sending failed for message ${msg.id}:`, err);
          errorMsg = err.message || "Failed to connect to BulkVS API";
        }
      }

      // Update message status based on success/failure
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

      // Schedule next check based on configured rate limit
      this.timer = setTimeout(() => {
        this.isProcessing = false;
        this.processNext();
      }, sendInterval);

    } catch (err) {
      console.error("Queue worker error processing message:", err);
      // Wait 5 seconds on system error before retrying
      this.timer = setTimeout(() => {
        this.isProcessing = false;
        this.processNext();
      }, 5000);
    }
  }
}

const worker = new QueueWorker();
module.exports = worker;
