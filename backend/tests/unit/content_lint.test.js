'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lint = require('../../content_lint');

const CLEAN = 'Hi [Name], this is Jimmy with Life Assurance following up on your quote request. Is now a good time? Reply STOP to opt out.';

test('a clean compliant template scores ok', () => {
  const result = lint.lint(CLEAN, { requireOptOut: true });
  assert.strictEqual(result.level, 'ok');
  assert.deepStrictEqual(result.findings, []);
});

test('URL shorteners are flagged high - the strongest carrier spam signal', () => {
  const result = lint.lint('Check your quote at bit.ly/abc123. Reply STOP to opt out.', { requireOptOut: true });
  const finding = result.findings.find(f => f.code === 'url_shortener');
  assert.ok(finding, 'expected a url_shortener finding');
  assert.strictEqual(finding.severity, 'high');
  assert.match(finding.message, /bit\.ly/);
});

test('missing opt-out is flagged for bulk but not for one-to-one', () => {
  const bulk = lint.lint('Hi, following up on your quote.', { requireOptOut: true });
  assert.ok(bulk.findings.some(f => f.code === 'missing_opt_out'));

  const reply = lint.lint('Hi, following up on your quote.', { requireOptOut: false });
  assert.ok(!reply.findings.some(f => f.code === 'missing_opt_out'));
});

test('several opt-out phrasings all satisfy the disclosure check', () => {
  for (const phrasing of ['Reply STOP to opt out.', 'Text STOP to cancel.', 'Reply STOP to unsubscribe.']) {
    const result = lint.lint(`Following up on your quote. ${phrasing}`, { requireOptOut: true });
    assert.ok(!result.findings.some(f => f.code === 'missing_opt_out'),
      `expected "${phrasing}" to count as opt-out language`);
  }
});

test('stacked trigger phrases escalate beyond the individual hits', () => {
  const result = lint.lint(
    'CONGRATULATIONS!! You are PRE-APPROVED for FREE guaranteed coverage - act now!!! Reply STOP to opt out.',
    { requireOptOut: true }
  );
  assert.strictEqual(result.level, 'high');
  assert.ok(result.findings.some(f => f.code === 'phrase_density'));
  assert.ok(result.findings.some(f => f.code === 'caps_heavy' || f.code === 'shouting'));
  assert.ok(result.findings.some(f => f.code === 'punctuation'));
});

test('brand check passes when any brand term is present', () => {
  const opts = { requireOptOut: false, brandTerms: ['Life Assurance', 'getlifeassurance'] };
  assert.ok(!lint.lint(CLEAN, opts).findings.some(f => f.code === 'missing_brand'));
  assert.ok(lint.lint('Following up on your quote.', opts).findings.some(f => f.code === 'missing_brand'));
});

test('segment maths matches the GSM-7 and UCS-2 boundaries', () => {
  assert.deepStrictEqual(lint.measure('a'.repeat(160)), { encoding: 'GSM-7', units: 160, segments: 1 });
  assert.deepStrictEqual(lint.measure('a'.repeat(161)), { encoding: 'GSM-7', units: 161, segments: 2 });

  // A single emoji drops the whole message to 70 chars per segment.
  const emoji = lint.measure('a'.repeat(100) + '\u{1F600}');
  assert.strictEqual(emoji.encoding, 'UCS-2');
  assert.strictEqual(emoji.segments, 2);
});

test('GSM-7 extension characters cost two units', () => {
  assert.strictEqual(lint.measure('{}').units, 4);
  assert.strictEqual(lint.measure('ab').units, 2);
});

test('smart quotes are called out because they silently force UCS-2', () => {
  const result = lint.lint('Hi — here’s your quote. Reply STOP to opt out.', { requireOptOut: true });
  const finding = result.findings.find(f => f.code === 'ucs2');
  assert.ok(finding);
  assert.strictEqual(finding.severity, 'medium');
  assert.match(finding.message, /word processor/);
});

test('empty input is ok rather than an error', () => {
  const result = lint.lint('', { requireOptOut: true });
  assert.strictEqual(result.level, 'ok');
  assert.strictEqual(result.measure.segments, 0);
});

test('multiple links are flagged', () => {
  const result = lint.lint('See example.com and other.com. Reply STOP to opt out.', { requireOptOut: true });
  assert.ok(result.findings.some(f => f.code === 'multiple_urls'));
});
