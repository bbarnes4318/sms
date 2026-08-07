'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Pacer, BLOCK, WARMUP_LADDER } = require('../../pacing');
const timezones = require('../../timezones');

// A DID that has been sending for long enough to be past its warm-up ramp.
const OLD_DAY = '2020-01-01';

function makePacer(overrides, summary) {
  return new Pacer({
    getSettings: () => Object.assign({
      pacing_enabled: '1',
      did_min_gap_ms: '10000',
      did_jitter_pct: '0',
      did_daily_cap: '100',
      did_warmup_enabled: '0',
      quiet_hours_enabled: '0',
      max_concurrent_sends: '3'
    }, overrides || {}),
    getDidSummary: () => summary || {}
  });
}

const MSG = { from_number: '8653456051', to_number: '2125550100' };

test('a fresh DID may send immediately', () => {
  const pacer = makePacer();
  assert.deepStrictEqual(pacer.evaluate(MSG), { ok: true });
});

test('the per-DID gap blocks the same number but not a different one', () => {
  const pacer = makePacer();
  const now = new Date('2026-06-01T15:00:00Z');

  pacer.recordSend('8653456051', now);

  const same = pacer.evaluate(MSG, new Date(now.getTime() + 1000));
  assert.strictEqual(same.ok, false);
  assert.strictEqual(same.reason, BLOCK.MIN_GAP);
  assert.strictEqual(same.retryInMs, 9000);

  // This is the whole point of per-DID pacing: a second number is unaffected.
  const other = pacer.evaluate({ from_number: '3215777735', to_number: '2125550100' },
    new Date(now.getTime() + 1000));
  assert.deepStrictEqual(other, { ok: true });
});

test('the gap clears once it has elapsed', () => {
  const pacer = makePacer();
  const now = new Date('2026-06-01T15:00:00Z');
  pacer.recordSend('8653456051', now);
  assert.strictEqual(pacer.evaluate(MSG, new Date(now.getTime() + 10001)).ok, true);
});

test('jitter keeps the cadence irregular around the configured gap', () => {
  const pacer = makePacer({ did_jitter_pct: '0.4' });
  const gaps = new Set();
  for (let i = 0; i < 40; i++) {
    const now = new Date('2026-06-01T15:00:00Z');
    const entry = pacer.recordSend(`555000${String(i).padStart(4, '0')}`, now);
    const gap = entry.nextAllowedAt - now.getTime();
    assert.ok(gap >= 6000 && gap <= 14000, `gap ${gap} outside +/-40% of 10000`);
    gaps.add(gap);
  }
  // A metronome is itself a bot fingerprint; the values must actually vary.
  assert.ok(gaps.size > 20, `expected varied gaps, saw ${gaps.size} distinct values`);
});

test('the daily cap blocks and reports the wait until midnight', () => {
  const pacer = makePacer({ did_daily_cap: '3' });
  const now = new Date();
  for (let i = 0; i < 3; i++) pacer.recordSend('8653456051', now);

  const verdict = pacer.evaluate(MSG, now);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.reason, BLOCK.DAILY_CAP);
  assert.ok(verdict.retryInMs > 0);
});

test('warm-up holds a brand new number to the first rung of the ladder', () => {
  const pacer = makePacer({ did_warmup_enabled: '1', did_daily_cap: '500' });
  const now = new Date();
  for (let i = 0; i < WARMUP_LADDER[0]; i++) pacer.recordSend('8653456051', now);

  const verdict = pacer.evaluate(MSG, now);
  assert.strictEqual(verdict.reason, BLOCK.DAILY_CAP);
  assert.match(verdict.detail, new RegExp(`/${WARMUP_LADDER[0]}`));
});

test('an established number is not held back by the warm-up ladder', () => {
  // The gap is zeroed so this asserts about the allowance only, not the cadence.
  const pacer = makePacer(
    { did_warmup_enabled: '1', did_daily_cap: '500', did_min_gap_ms: '0' },
    { '8653456051': { firstSendDay: OLD_DAY, sentToday: 0, day: 'never' } }
  );
  const now = new Date();
  for (let i = 0; i < WARMUP_LADDER[0] + 5; i++) pacer.recordSend('8653456051', now);
  assert.strictEqual(pacer.evaluate(MSG, now).ok, true);
});

test('seeding from send history survives a restart mid-day', () => {
  const today = new Date().toLocaleDateString('en-CA');
  const pacer = makePacer(
    { did_daily_cap: '10' },
    { '8653456051': { firstSendDay: OLD_DAY, sentToday: 10, day: today } }
  );
  // Without seeding, a restart would hand this number a fresh allowance.
  const verdict = pacer.evaluate(MSG, new Date());
  assert.strictEqual(verdict.reason, BLOCK.DAILY_CAP);
});

test('yesterday\'s count does not carry into today', () => {
  const pacer = makePacer(
    { did_daily_cap: '10' },
    { '8653456051': { firstSendDay: OLD_DAY, sentToday: 10, day: '1999-01-01' } }
  );
  assert.strictEqual(pacer.evaluate(MSG, new Date()).ok, true);
});

test('a failure spike pauses the number, and only after enough samples', () => {
  const pacer = makePacer({ did_failure_min_samples: '4', did_failure_threshold: '0.5' });
  const now = new Date();

  assert.strictEqual(pacer.recordOutcome('8653456051', false, now), null, 'too few samples to judge');
  assert.strictEqual(pacer.recordOutcome('8653456051', false, now), null);
  assert.strictEqual(pacer.recordOutcome('8653456051', false, now), null);

  const paused = pacer.recordOutcome('8653456051', false, now);
  assert.ok(paused, 'expected a pause once the sample size was reached');

  const verdict = pacer.evaluate(MSG, now);
  assert.strictEqual(verdict.reason, BLOCK.PAUSED);
});

test('a healthy number is never paused', () => {
  const pacer = makePacer({ did_failure_min_samples: '4' });
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    assert.strictEqual(pacer.recordOutcome('8653456051', true, now), null);
  }
  assert.strictEqual(pacer.evaluate(MSG, now).ok, true);
});

test('resume clears a pause', () => {
  const pacer = makePacer({ did_failure_min_samples: '3', did_failure_threshold: '0.5' });
  const now = new Date();
  for (let i = 0; i < 3; i++) pacer.recordOutcome('8653456051', false, now);
  assert.strictEqual(pacer.evaluate(MSG, now).reason, BLOCK.PAUSED);

  assert.strictEqual(pacer.resume('8653456051'), true);
  assert.strictEqual(pacer.evaluate(MSG, now).ok, true);
});

test('quiet hours block a recipient whose local time is outside the window', () => {
  const pacer = makePacer({ quiet_hours_enabled: '1', quiet_start_hour: '9', quiet_end_hour: '20' });

  // 08:00 UTC is 03:00 or 04:00 in New York depending on DST - either way,
  // comfortably before the window opens.
  const early = pacer.evaluate({ from_number: '8653456051', to_number: '2125550100' },
    new Date('2026-06-01T08:00:00Z'));
  assert.strictEqual(early.ok, false);
  assert.strictEqual(early.reason, BLOCK.QUIET_HOURS);
  assert.ok(early.retryInMs > 0);

  // 17:00 UTC is 13:00 in New York - inside the window.
  const midday = pacer.evaluate({ from_number: '8653456051', to_number: '2125550100' },
    new Date('2026-06-01T17:00:00Z'));
  assert.strictEqual(midday.ok, true);
});

test('an unknown area code falls back to requiring the window in both coasts', () => {
  const pacer = makePacer({ quiet_hours_enabled: '1', quiet_start_hour: '9', quiet_end_hour: '20' });
  const unknown = { from_number: '8653456051', to_number: '0000000000' };

  // 16:00 UTC is 12:00 Eastern (inside) but 09:00 Pacific (just inside too).
  assert.strictEqual(pacer.evaluate(unknown, new Date('2026-06-01T16:00:00Z')).ok, true);

  // 14:00 UTC is 10:00 Eastern (inside) but 07:00 Pacific (too early), so the
  // conservative rule blocks it.
  const tooEarlyOnTheWestCoast = pacer.evaluate(unknown, new Date('2026-06-01T14:00:00Z'));
  assert.strictEqual(tooEarlyOnTheWestCoast.ok, false);
  assert.strictEqual(tooEarlyOnTheWestCoast.reason, BLOCK.QUIET_HOURS);
});

test('pacing can be turned off entirely', () => {
  const pacer = makePacer({ pacing_enabled: '0', did_daily_cap: '1' });
  const now = new Date();
  for (let i = 0; i < 50; i++) pacer.recordSend('8653456051', now);
  assert.deepStrictEqual(pacer.evaluate(MSG, now), { ok: true });
});

test('DID identity is normalised across formats', () => {
  const pacer = makePacer();
  const now = new Date('2026-06-01T15:00:00Z');
  pacer.recordSend('+1 (865) 345-6051', now);
  const verdict = pacer.evaluate({ from_number: '8653456051', to_number: '2125550100' },
    new Date(now.getTime() + 1000));
  assert.strictEqual(verdict.reason, BLOCK.MIN_GAP);
});

test('snapshot reports what an operator needs to diagnose a slow queue', () => {
  const pacer = makePacer({ did_warmup_enabled: '1', did_daily_cap: '500' });
  pacer.recordSend('8653456051', new Date());
  const [row] = pacer.snapshot();
  assert.strictEqual(row.did, '8653456051');
  assert.strictEqual(row.sent_today, 1);
  assert.strictEqual(row.warming_up, true);
  assert.strictEqual(row.paused, false);
});

test('timezone inference handles area codes that split from their state', () => {
  // Florida is Eastern, but the 850 panhandle is Central.
  assert.strictEqual(timezones.timezoneFor('8505550100'), 'America/Chicago');
  assert.strictEqual(timezones.timezoneFor('3055550100'), 'America/New_York');
  // Texas is Central, but El Paso is Mountain.
  assert.strictEqual(timezones.timezoneFor('9155550100'), 'America/Denver');
  assert.strictEqual(timezones.timezoneFor('2145550100'), 'America/Chicago');
  assert.strictEqual(timezones.timezoneFor('not-a-number'), null);
});
