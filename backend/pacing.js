/**
 * Outbound send pacing.
 *
 * Replaces the single global `send_interval_ms` metronome. That design had two
 * problems: an exactly-regular cadence is itself a bot fingerprint, and one
 * global rate meant a pool of six DIDs sent no faster than one, while each
 * individual number could still be pushed past what carriers tolerate.
 *
 * Pacing is now per-DID, and every gate answers a different question:
 *
 *   paused    - is this number in a failure spike we should back off from?
 *   quiet     - is it a civil hour where the recipient actually lives?
 *   cap       - has this number already sent its allowance for the day?
 *   gap       - has enough (jittered) time passed since its last send?
 *
 * A message that fails a gate is not dropped. The gate reports when it will
 * next be eligible, and the worker moves on to a message that is sendable now.
 * Six DIDs each sending slowly in parallel beats one sending quickly.
 *
 * State lives in memory and is seeded from the database on start, so a restart
 * does not hand a number a fresh daily allowance.
 */
const timezones = require('./timezones');

const DEFAULTS = {
  pacing_enabled: '1',
  did_min_gap_ms: '12000',
  did_jitter_pct: '0.4',
  did_daily_cap: '300',
  did_warmup_enabled: '1',
  did_failure_threshold: '0.5',
  did_failure_min_samples: '8',
  did_failure_pause_ms: '900000',
  quiet_hours_enabled: '1',
  quiet_start_hour: '9',
  quiet_end_hour: '20',
  max_concurrent_sends: '3'
};

// Daily allowance for a number by its age in days of active sending. A new DID
// that opens at full volume looks exactly like a number bought to spam from.
// Index is days active; past the end of the ladder the configured cap applies.
const WARMUP_LADDER = [10, 25, 50, 100, 175, 250];

// Rolling window of recent send outcomes kept per DID for spike detection.
const OUTCOME_WINDOW = 20;

const BLOCK = {
  PAUSED: 'paused',
  QUIET_HOURS: 'quiet_hours',
  DAILY_CAP: 'daily_cap',
  MIN_GAP: 'min_gap'
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Server-local calendar day key. Daily caps reset on this boundary. */
function dayKey(at) {
  const d = at || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromKey, toKey) {
  const from = new Date(`${fromKey}T00:00:00Z`).getTime();
  const to = new Date(`${toKey}T00:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400000));
}

function normalizeDid(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

class Pacer {
  /**
   * @param {object} deps
   *   deps.getSettings   () => settings object
   *   deps.getDidSummary () => { [did]: {firstSendDay, sentToday, day} }
   */
  constructor(deps) {
    this.getSettings = deps.getSettings;
    this.getDidSummary = deps.getDidSummary || (() => ({}));
    this.state = new Map();
    this.seeded = false;
    this.settingsCache = null;
    this.settingsCachedAt = 0;
  }

  /**
   * Populate per-DID counters from send history. Called once, lazily, so a
   * restart mid-campaign does not reset every number's daily allowance.
   */
  seed(at) {
    if (this.seeded) return;
    this.seeded = true;
    const today = dayKey(at);
    let summary = {};
    try {
      summary = this.getDidSummary() || {};
    } catch (err) {
      console.error('[pacing] could not seed from send history:', err.message);
      return;
    }
    for (const [did, history] of Object.entries(summary)) {
      const key = normalizeDid(did);
      if (!key) continue;
      this.state.set(key, {
        did: key,
        firstSendDay: history.firstSendDay || null,
        day: today,
        sentToday: history.day === today ? (history.sentToday || 0) : 0,
        nextAllowedAt: 0,
        lastSentAt: null,
        outcomes: [],
        pausedUntil: 0,
        pauseReason: null
      });
    }
    console.log(`[pacing] seeded ${this.state.size} DID(s) from send history.`);
  }

  config() {
    // The worker calls this many times a second; re-reading settings from
    // SQLite every time is wasteful and a two-second staleness is harmless.
    const now = Date.now();
    if (this.settingsCache && now - this.settingsCachedAt < 2000) return this.settingsCache;

    const settings = this.getSettings() || {};
    const value = key => (settings[key] === undefined || settings[key] === '' ? DEFAULTS[key] : settings[key]);

    this.settingsCache = {
      enabled: String(value('pacing_enabled')) === '1',
      minGapMs: Math.max(0, num(value('did_min_gap_ms'), 12000)),
      jitterPct: Math.min(0.9, Math.max(0, num(value('did_jitter_pct'), 0.4))),
      dailyCap: Math.max(1, num(value('did_daily_cap'), 300)),
      warmupEnabled: String(value('did_warmup_enabled')) === '1',
      failureThreshold: Math.min(1, Math.max(0, num(value('did_failure_threshold'), 0.5))),
      failureMinSamples: Math.max(3, num(value('did_failure_min_samples'), 8)),
      failurePauseMs: Math.max(60000, num(value('did_failure_pause_ms'), 900000)),
      quietEnabled: String(value('quiet_hours_enabled')) === '1',
      quietStart: Math.min(23, Math.max(0, num(value('quiet_start_hour'), 9))),
      quietEnd: Math.min(24, Math.max(1, num(value('quiet_end_hour'), 20))),
      maxConcurrent: Math.max(1, Math.min(20, num(value('max_concurrent_sends'), 3)))
    };
    this.settingsCachedAt = now;
    return this.settingsCache;
  }

  invalidateConfig() {
    this.settingsCache = null;
  }

  didState(did, at) {
    this.seed(at);
    const key = normalizeDid(did);
    let entry = this.state.get(key);
    const today = dayKey(at);

    if (!entry) {
      // A DID with no send history at all: day 0 of its warm-up.
      entry = {
        did: key,
        firstSendDay: null,
        day: today,
        sentToday: 0,
        nextAllowedAt: 0,
        lastSentAt: null,
        outcomes: [],
        pausedUntil: 0,
        pauseReason: null
      };
      this.state.set(key, entry);
    }

    if (entry.day !== today) {
      entry.day = today;
      entry.sentToday = 0;
    }
    return entry;
  }

  /** Today's allowance for a DID, accounting for the warm-up ramp. */
  dailyAllowance(entry, cfg, at) {
    if (!cfg.warmupEnabled || !entry.firstSendDay) {
      // A number that has never sent is on day 0 of its ramp.
      return cfg.warmupEnabled ? Math.min(cfg.dailyCap, WARMUP_LADDER[0]) : cfg.dailyCap;
    }
    const age = daysBetween(entry.firstSendDay, dayKey(at));
    if (age >= WARMUP_LADDER.length) return cfg.dailyCap;
    return Math.min(cfg.dailyCap, WARMUP_LADDER[age]);
  }

  /**
   * Milliseconds until the recipient's local time enters the sending window,
   * or 0 if it already has.
   *
   * When the recipient's timezone cannot be inferred the window must hold in
   * both Eastern and Pacific, which is compliant for any US number.
   */
  quietHoursDelay(toNumber, cfg, at) {
    const now = at || new Date();
    const local = timezones.localTimeFor(toNumber, now);
    const zones = local
      ? [local]
      : [timezones.localTimeFor('+12125550100', now), timezones.localTimeFor('+13105550100', now)]
          .filter(Boolean);

    if (!zones.length) return 0;

    let worst = 0;
    for (const zone of zones) {
      if (zone.hour >= cfg.quietStart && zone.hour < cfg.quietEnd) continue;
      const hoursUntilOpen = ((cfg.quietStart - zone.hour) + 24) % 24;
      const msIntoHour = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) * 1000 + now.getUTCMilliseconds();
      // All US zones are whole-hour offsets, so minutes past the hour match UTC.
      const delay = hoursUntilOpen * 3600000 - msIntoHour;
      if (delay > worst) worst = delay;
    }
    return Math.max(0, worst);
  }

  /**
   * Can this message be sent right now?
   *
   * @returns {{ok: true}} or {{ok: false, reason: string, retryInMs: number, detail: string}}
   */
  evaluate(msg, at) {
    const cfg = this.config();
    const now = at || new Date();
    if (!cfg.enabled) return { ok: true };

    const entry = this.didState(msg.from_number, now);
    const nowMs = now.getTime();

    if (entry.pausedUntil > nowMs) {
      return {
        ok: false,
        reason: BLOCK.PAUSED,
        retryInMs: entry.pausedUntil - nowMs,
        detail: `DID ${entry.did} paused: ${entry.pauseReason}`
      };
    }

    if (cfg.quietEnabled) {
      const delay = this.quietHoursDelay(msg.to_number, cfg, now);
      if (delay > 0) {
        return {
          ok: false,
          reason: BLOCK.QUIET_HOURS,
          retryInMs: delay,
          detail: `outside ${cfg.quietStart}:00-${cfg.quietEnd}:00 recipient local time`
        };
      }
    }

    const allowance = this.dailyAllowance(entry, cfg, now);
    if (entry.sentToday >= allowance) {
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      return {
        ok: false,
        reason: BLOCK.DAILY_CAP,
        retryInMs: midnight.getTime() - nowMs,
        detail: `DID ${entry.did} hit its daily allowance (${entry.sentToday}/${allowance})`
      };
    }

    if (entry.nextAllowedAt > nowMs) {
      return {
        ok: false,
        reason: BLOCK.MIN_GAP,
        retryInMs: entry.nextAllowedAt - nowMs,
        detail: `DID ${entry.did} rate limited`
      };
    }

    return { ok: true };
  }

  /**
   * Record that a send was dispatched. Sets the next eligible time with jitter
   * so the cadence is irregular rather than a metronome.
   */
  recordSend(did, at) {
    const cfg = this.config();
    const now = at || new Date();
    const entry = this.didState(did, now);
    entry.sentToday++;
    entry.lastSentAt = now.toISOString();
    if (!entry.firstSendDay) entry.firstSendDay = dayKey(now);

    const spread = 1 + (Math.random() * 2 - 1) * cfg.jitterPct;
    entry.nextAllowedAt = now.getTime() + Math.round(cfg.minGapMs * spread);
    return entry;
  }

  /**
   * Record a send outcome. A number that starts failing is usually a number the
   * carrier has begun rejecting, and hammering it makes the reputation worse.
   * Configuration errors are excluded: those fail on every DID and would pause
   * the whole pool.
   */
  recordOutcome(did, success, at) {
    const cfg = this.config();
    const now = at || new Date();
    const entry = this.didState(did, now);

    entry.outcomes.push(success ? 1 : 0);
    if (entry.outcomes.length > OUTCOME_WINDOW) entry.outcomes.shift();

    if (entry.outcomes.length < cfg.failureMinSamples) return null;
    const failures = entry.outcomes.filter(o => o === 0).length;
    const rate = failures / entry.outcomes.length;
    if (rate < cfg.failureThreshold) return null;

    entry.pausedUntil = now.getTime() + cfg.failurePauseMs;
    entry.pauseReason = `${failures}/${entry.outcomes.length} recent sends failed`;
    // Reset the window so the DID is judged fresh when the pause expires,
    // rather than immediately re-pausing on the same stale failures.
    entry.outcomes = [];
    console.warn(`[pacing] DID ${entry.did} paused for ${Math.round(cfg.failurePauseMs / 60000)}m: ${entry.pauseReason}`);
    return { did: entry.did, pausedUntil: entry.pausedUntil, reason: entry.pauseReason };
  }

  /** Manually clear a pause (operator override). */
  resume(did) {
    const entry = this.state.get(normalizeDid(did));
    if (!entry) return false;
    entry.pausedUntil = 0;
    entry.pauseReason = null;
    entry.outcomes = [];
    return true;
  }

  /** Per-DID view for the status endpoint. */
  snapshot(at) {
    const cfg = this.config();
    const now = at || new Date();
    this.seed(now);
    const nowMs = now.getTime();
    return Array.from(this.state.values()).map(entry => ({
      did: entry.did,
      sent_today: entry.sentToday,
      daily_allowance: this.dailyAllowance(entry, cfg, now),
      warming_up: cfg.warmupEnabled && this.dailyAllowance(entry, cfg, now) < cfg.dailyCap,
      first_send_day: entry.firstSendDay,
      last_sent_at: entry.lastSentAt,
      next_allowed_in_ms: Math.max(0, entry.nextAllowedAt - nowMs),
      paused: entry.pausedUntil > nowMs,
      paused_for_ms: Math.max(0, entry.pausedUntil - nowMs),
      pause_reason: entry.pausedUntil > nowMs ? entry.pauseReason : null
    }));
  }
}

module.exports = { Pacer, BLOCK, DEFAULTS, WARMUP_LADDER, dayKey, normalizeDid };
