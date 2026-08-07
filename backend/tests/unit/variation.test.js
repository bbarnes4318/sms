'use strict';

const test = require('node:test');
const assert = require('node:assert');
const variation = require('../../variation');

const SOURCE = 'Hi [Name], this is Jimmy with Life Assurance about the $250,000 policy you asked about. Call 8653456051. Reply STOP to opt out.';

// A rewrite is only acceptable if it is demonstrably the same message. These
// tests pin the specific ways a rewrite can be wrong, because every one of them
// is a compliance or accuracy problem rather than a style problem.

test('a faithful rewrite is accepted', () => {
  const variant = 'Hi [Name], Jimmy here from Life Assurance regarding the $250,000 policy you enquired about. Call 8653456051. Reply STOP to opt out.';
  assert.strictEqual(variation.rejectionReason(SOURCE, variant), null);
});

test('a changed dollar amount is rejected', () => {
  const variant = 'Hi [Name], Jimmy here from Life Assurance regarding the $500,000 policy you enquired about. Call 8653456051. Reply STOP to opt out.';
  assert.match(variation.rejectionReason(SOURCE, variant), /numbers, links, or contact details/);
});

test('a changed phone number is rejected', () => {
  const variant = 'Hi [Name], Jimmy here from Life Assurance regarding the $250,000 policy you enquired about. Call 8005551234. Reply STOP to opt out.';
  assert.match(variation.rejectionReason(SOURCE, variant), /numbers, links, or contact details/);
});

test('dropping the opt-out disclosure is rejected', () => {
  const variant = 'Hi [Name], Jimmy here from Life Assurance regarding the $250,000 policy you enquired about. Call 8653456051.';
  assert.match(variation.rejectionReason(SOURCE, variant), /opt-out/);
});

test('losing or inventing a merge placeholder is rejected', () => {
  const dropped = 'Hi there, Jimmy here from Life Assurance regarding the $250,000 policy you enquired about. Call 8653456051. Reply STOP to opt out.';
  assert.match(variation.rejectionReason(SOURCE, dropped), /placeholders/);

  const invented = 'Hi [Name] in [City], Jimmy from Life Assurance regarding the $250,000 policy. Call 8653456051. Reply STOP to opt out.';
  assert.ok(variation.rejectionReason(SOURCE, invented));
});

test('a variant that adds spam-trigger content is rejected', () => {
  const variant = 'Hi [Name], GUARANTEED FREE $250,000 policy - act now!!! Call 8653456051. Reply STOP to opt out.';
  assert.ok(variation.rejectionReason(SOURCE, variant));
});

test('a runaway-length variant is rejected', () => {
  const variant = 'Hi [Name], ' + 'padding '.repeat(40) +
    'the $250,000 policy. Call 8653456051. Reply STOP to opt out.';
  assert.match(String(variation.rejectionReason(SOURCE, variant)), /runaway length|segment/);
});

test('a slightly longer variant is kept when it still fits the same segments', () => {
  // The old character budget rejected these, which threw away half the pool
  // for no benefit: segment cost, not character count, is what a send is
  // billed on. Source and variant both fit one segment merged, so it stays.
  const source = 'Hi [Name], Jimmy from Life Assurance about your [City] quote. Reply STOP to opt out.';
  const longer = 'Hi [Name], this is Jimmy at Life Assurance regarding your [City] quote. Reply STOP to opt out.';
  const widths = { name: 11, city: 12, zip: 5 };

  assert.ok(longer.length > source.length * 1.05, 'variant is meaningfully longer');
  assert.strictEqual(variation.measureMerged(source, widths).segments, 1);
  assert.strictEqual(variation.measureMerged(longer, widths).segments, 1);
  assert.strictEqual(variation.rejectionReason(source, longer, { placeholderWidths: widths }), null);
});

test('an empty or identical variant is rejected', () => {
  assert.strictEqual(variation.rejectionReason(SOURCE, ''), 'empty');
  assert.strictEqual(variation.rejectionReason(SOURCE, SOURCE), 'identical to source');
});

test('token extraction survives punctuation and case differences', () => {
  const a = variation.extractTokens('Call 865-345-6051 or visit Example.com for $1,000.');
  const b = variation.extractTokens('Visit example.COM or call 8653456051 about $1,000.');
  assert.deepStrictEqual(a, b);
});

test('a URL swapped for a lookalike domain is rejected', () => {
  const source = 'Your quote is ready at getlifeassurance.com. Reply STOP to opt out.';
  const variant = 'Your quote is ready at get-lifeassurance.com. Reply STOP to opt out.';
  assert.match(variation.rejectionReason(source, variant), /numbers, links, or contact details/);
});

test('curly quotes are folded to ASCII so a good rewrite is not lost to UCS-2', () => {
  const curly = 'Hi [Name], Jimmy here — I’m following up on the $250,000 policy you “asked” about. Call 8653456051. Reply STOP to opt out.';
  const folded = variation.normalizeTypography(curly);
  assert.ok(!/[‘’“”–—]/.test(folded), 'expected no typographic characters to survive');
  assert.match(folded, /I'm/);
  assert.match(folded, /"asked"/);
  // The whole point: after folding it stays GSM-7 and is accepted.
  const contentLint = require('../../content_lint');
  assert.strictEqual(contentLint.measure(folded).encoding, 'GSM-7');
  assert.strictEqual(variation.rejectionReason(SOURCE, folded), null);
});

test('segment checks measure merged text, not the raw template', () => {
  // A template cannot be measured directly: "[Name]" is 6 characters on screen
  // but 8 GSM-7 units, because [ and ] are extension characters. Then it is
  // replaced by a real name of a completely different length.
  const contentLint = require('../../content_lint');
  const tpl = 'Hi [Name], your quote is ready.';
  assert.strictEqual(contentLint.measure(tpl).units, tpl.length + 2, 'brackets cost 2 units each');

  const filled = variation.fillPlaceholders(tpl, { name: 11 });
  assert.ok(!filled.includes('['), 'placeholders must be gone after filling');
  assert.strictEqual(filled.length, tpl.length - 6 + 11);
});

test('a rewrite that only overflows once a long name is merged is rejected', () => {
  // 142 chars of template. With a 6-char [Name] it looks like one segment; with
  // a 20-character name merged in, the longer rewrite tips over 160 and the
  // original does not. Comparing templates would let this through.
  const source = 'Hi [Name], Jimmy from Life Assurance here about the coverage quote you asked for. Do you have five minutes this week? Reply STOP to opt out.';
  const longer = 'Hi [Name], this is Jimmy calling from Life Assurance regarding the coverage quote you requested. Would you have about five minutes spare this week? Reply STOP to opt out.';
  const widths = { name: 20, city: 14, zip: 5 };

  const contentLint = require('../../content_lint');
  assert.strictEqual(variation.measureMerged(source, widths).segments, 1, 'source fits one segment merged');
  assert.strictEqual(variation.measureMerged(longer, widths).segments, 2, 'variant needs two merged');

  const reason = variation.rejectionReason(source, longer, { placeholderWidths: widths });
  assert.match(String(reason), /segment|too long/);
});

test('placeholder fill widths default sanely when none are supplied', () => {
  assert.ok(variation.DEFAULT_PLACEHOLDER_WIDTHS.name > 0);
  const filled = variation.fillPlaceholders('Hi [Name] in [City] [Zip]');
  assert.ok(!/\[/.test(filled), 'every placeholder kind must be filled');
});

test('isEnabled requires both the flag and a key', () => {
  assert.strictEqual(variation.isEnabled({ variation_enabled: '1', anthropic_api_key: 'sk-x' }), true);
  assert.strictEqual(variation.isEnabled({ variation_enabled: '1', anthropic_api_key: '' }), false);
  assert.strictEqual(variation.isEnabled({ variation_enabled: '0', anthropic_api_key: 'sk-x' }), false);
  assert.strictEqual(variation.isEnabled({}), false);
});

test('buildPool falls back to the bare template when variation is off', async () => {
  const result = await variation.buildPool(SOURCE, { variation_enabled: '0' });
  assert.deepStrictEqual(result.pool, [SOURCE]);
  assert.strictEqual(result.enabled, false);
});

test('generateVariants resolves with nulls rather than throwing when unconfigured', async () => {
  const { variants, stats } = await variation.generateVariants(SOURCE, 3, { apiKey: '' });
  assert.deepStrictEqual(variants, [null, null, null]);
  assert.match(stats.error, /no API key/);
});
