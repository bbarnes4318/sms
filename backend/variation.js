/**
 * Per-recipient message variation.
 *
 * Every recipient in a campaign currently receives a byte-identical body apart
 * from merge fields, which is exactly the fingerprint carrier content filters
 * hash on. This rewrites each message into its own wording before it is queued.
 *
 * Two rules shape the design:
 *
 *   1. Rewrites are CONSTRAINED, not creative. This is insurance lead-gen: an
 *      LLM that invents a rate, a carrier name, or a guarantee creates real
 *      liability. Every variant is machine-checked against the original and
 *      rejected if it drops the opt-out disclosure, alters a number or URL, or
 *      introduces claim language the original did not have.
 *
 *   2. Failure is never a blocked send. A rejected variant, a missing API key,
 *      a timeout, or a malformed response all fall back to the original merged
 *      body. The worst case is the behaviour we have today.
 *
 * Runs at queue time, not send time: variants are visible in the UI before
 * anything goes out, the send path keeps its current latency and failure modes,
 * and every variant is stored for audit.
 */
const Anthropic = require('@anthropic-ai/sdk');
const contentLint = require('./content_lint');

// Batching one request per recipient would be needlessly slow and expensive.
// One request produces N distinct rewrites, which also lets the model see the
// other variants it has already written and avoid converging on one phrasing.
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MODEL = 'claude-opus-5';
const REQUEST_TIMEOUT_MS = 60000;

const SYSTEM_PROMPT = `You rewrite outbound SMS messages for a licensed US insurance agency so that each recipient receives distinct wording. You are a paraphraser, not a copywriter.

For each requested variant, rewrite the source message so it differs in sentence structure and word choice from the source and from every other variant, while saying exactly the same thing.

Preserve exactly, character for character:
- Every number, dollar amount, percentage, date, and time.
- Every URL, phone number, and email address.
- Every proper noun: business names, carrier names, product names, person names, city names.
- The opt-out sentence, if the source has one. Keep it verbatim and keep it last.

Never introduce:
- Any factual claim, rate, price, benefit, coverage detail, eligibility statement, or guarantee that is not already stated in the source.
- Urgency or scarcity framing ("act now", "limited time", "expires today") unless the source already has it.
- Superlatives, emoji, ALL-CAPS words, or exclamation marks the source does not have.
- A greeting or sign-off the source does not have.

Keep each variant within the source's character count plus 15%. Match the source's register: plain, direct, conversational. If the source is a question, the variant is a question.

Some source messages contain merge placeholders in square brackets such as [Name], [City], or [Zip]. Reproduce these placeholders exactly as written, in a position where the substituted value reads naturally. Never invent a value for them.`;

const VARIANT_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      description: 'One rewrite per requested index, in order.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The requested variant index.' },
          text: { type: 'string', description: 'The rewritten message.' }
        },
        required: ['index', 'text'],
        additionalProperties: false
      }
    }
  },
  required: ['variants'],
  additionalProperties: false
};

let client = null;
let clientKey = null;

function getClient(apiKey) {
  if (!apiKey) return null;
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
    clientKey = apiKey;
  }
  return client;
}

/* ==================================================================
 * Validation
 *
 * A variant is accepted only if it is demonstrably the same message.
 * Each check answers one question about what the rewrite must not change.
 * ================================================================== */

// Numbers, money, URLs, emails, and phone numbers must survive verbatim.
//
// Each pattern carries its own normaliser, because "the same token" means
// different things per kind: 865-345-6051 and 8653456051 are the same phone
// number, but getlifeassurance.com and get-lifeassurance.com are emphatically
// not the same domain. A single blanket strip would collapse that distinction
// and let a lookalike domain through.
const TOKEN_PATTERNS = [
  { re: /https?:\/\/[^\s]+/gi, normalize: t => t.toLowerCase().replace(/\/+$/, '') },
  { re: /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|us|info|biz)(?:\/[^\s]*)?/gi, normalize: t => t.toLowerCase().replace(/\/+$/, '') },
  { re: /[\w.+-]+@[\w-]+\.[\w.-]+/gi, normalize: t => t.toLowerCase() },
  // Phone numbers: formatting is cosmetic, the digits are not.
  { re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, normalize: t => `tel:${t.replace(/\D/g, '')}` },
  // Money and percentages: thousands separators are cosmetic.
  { re: /\$\s?\d[\d,]*(?:\.\d+)?/g, normalize: t => `usd:${t.replace(/[^\d.]/g, '')}` },
  { re: /\b\d[\d,]*(?:\.\d+)?%/g, normalize: t => `pct:${t.replace(/[^\d.]/g, '')}` },
  { re: /\b\d[\d,]*(?:\.\d+)?\b/g, normalize: t => `num:${t.replace(/[^\d.]/g, '')}` }
];

function extractTokens(text) {
  const found = [];
  let remaining = String(text == null ? '' : text);
  for (const { re, normalize } of TOKEN_PATTERNS) {
    const matches = remaining.match(re) || [];
    for (const match of matches) found.push(normalize(match.trim()));
    // Consume matches so a phone number is not also counted as three integers,
    // and a URL's digits are not counted separately from the URL.
    remaining = remaining.replace(re, ' ');
  }
  return found.sort();
}

function extractPlaceholders(text) {
  return (text.match(/\[[^\]\n]{1,32}\]/g) || [])
    .map(p => p.toLowerCase())
    .sort();
}

function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

function normalizeForCompare(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* ------------------------------------------------------------------
 * Measuring a template the way the handset will see it.
 *
 * A template cannot be measured directly. "[Name]" is six characters on screen
 * but eight GSM-7 units, because [ and ] are extension characters that cost two
 * each - and then they vanish on merge and are replaced by a real name that may
 * be longer or shorter. So a 160-character template reads as two segments while
 * the message that actually goes out may be one, or vice versa.
 *
 * Comparing a rewrite against the original therefore has to happen on merged
 * text, using the same substitution for both, at the longest values that
 * actually occur in the contact list. Otherwise a rewrite ten characters longer
 * than the original passes the check and then silently costs an extra segment
 * on every contact with a long name.
 * ------------------------------------------------------------------ */

// Fallbacks used when the caller supplies no measured widths.
const DEFAULT_PLACEHOLDER_WIDTHS = { name: 14, city: 14, zip: 5 };

function fillPlaceholders(text, widths) {
  const w = Object.assign({}, DEFAULT_PLACEHOLDER_WIDTHS, widths || {});
  return String(text)
    .replace(/\[Name\]/gi, 'N'.repeat(Math.max(0, w.name)))
    .replace(/\[City\]/gi, 'C'.repeat(Math.max(0, w.city)))
    .replace(/\[Zip(?:\s*Code)?\]/gi, 'Z'.repeat(Math.max(0, w.zip)));
}

/**
 * What this template costs to send, once merge fields are substituted at their
 * worst-case width. This is the number that matters - the template's own
 * character count is not it.
 */
function measureMerged(text, widths) {
  return contentLint.measure(fillPlaceholders(text, widths));
}

/**
 * Fold typographic characters back to their ASCII equivalents.
 *
 * Models reach for curly quotes and en dashes because that is correct prose,
 * but in SMS a single one of them pushes the whole message from GSM-7 to UCS-2,
 * which cuts the per-segment budget from 160 characters to 70 and can add a
 * segment. Rejecting an otherwise perfect rewrite over an apostrophe wastes it;
 * the character carries no meaning here, so it is normalised instead.
 */
function normalizeTypography(text) {
  return String(text)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

/**
 * Reject a variant that is not a faithful rewrite of the source.
 * Returns null when the variant is acceptable, or a reason string when not.
 */
function rejectionReason(source, variant, options) {
  const widths = (options && options.placeholderWidths) || null;
  const text = String(variant == null ? '' : variant).trim();
  if (!text) return 'empty';

  if (!sameMultiset(extractTokens(source), extractTokens(text))) {
    return 'numbers, links, or contact details were altered';
  }
  if (!sameMultiset(extractPlaceholders(source), extractPlaceholders(text))) {
    return 'merge placeholders were altered';
  }

  const sourceHasOptOut = contentLint.OPT_OUT_RE.test(source);
  if (sourceHasOptOut && !contentLint.OPT_OUT_RE.test(text)) {
    return 'opt-out language was dropped';
  }

  // Sanity cap only. What actually matters is the merged segment count checked
  // below, and it is the authority: a rewrite 20% longer than the original but
  // still inside one segment costs nothing and is a perfectly good variant.
  // A tight character budget here just throws away half the pool for no gain.
  if (text.length > source.length * 2) {
    return `runaway length (${text.length} vs source ${source.length})`;
  }

  // The variant must not be riskier than what a human approved.
  const sourceLint = contentLint.lint(source, {});
  const variantLint = contentLint.lint(text, {});
  if (variantLint.score > sourceLint.score) {
    const added = variantLint.findings
      .filter(f => !sourceLint.findings.some(s => s.code === f.code))
      .map(f => f.code);
    return `introduced new spam-trigger content (${added.join(', ') || 'higher risk score'})`;
  }

  // Segment count is judged on MERGED text, both sides filled the same way.
  // Judging the raw templates would compare bracket characters that never get
  // sent and miss the real cost, which only appears once a name is substituted.
  const sourceMerged = measureMerged(source, widths);
  const variantMerged = measureMerged(text, widths);
  if (variantMerged.segments > sourceMerged.segments) {
    return `adds an SMS segment once merged (${variantMerged.segments} vs ${sourceMerged.segments})`;
  }
  if (variantMerged.encoding === 'UCS-2' && sourceMerged.encoding === 'GSM-7') {
    return 'forces UCS-2 encoding';
  }

  // A rewrite identical to the source defeats the purpose; treat it as a miss
  // so the caller records that this recipient got the original.
  if (normalizeForCompare(text) === normalizeForCompare(source)) {
    return 'identical to source';
  }

  return null;
}

/* ==================================================================
 * Generation
 * ================================================================== */

function buildUserPrompt(source, count) {
  return [
    `Rewrite the message below into ${count} distinct variants, numbered 0 through ${count - 1}.`,
    '',
    'SOURCE MESSAGE:',
    '"""',
    source,
    '"""',
    '',
    `Return exactly ${count} variants. Each must differ from the source and from every other variant in sentence structure and word choice, while stating the same facts and preserving every number, link, proper noun, merge placeholder, and the opt-out sentence exactly as written.`
  ].join('\n');
}

async function requestBatch(anthropic, model, source, count) {
  const response = await anthropic.messages.create({
    model,
    // max_tokens caps thinking and response text together, and thinking is on
    // by default on current models. Sizing this to the rewrites alone would
    // truncate mid-response; the headroom costs nothing when unused.
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      // Constrained paraphrasing is not a reasoning-heavy task, and low effort
      // keeps this fast and cheap enough to run on every campaign.
      effort: 'low',
      format: { type: 'json_schema', schema: VARIANT_SCHEMA }
    },
    messages: [{ role: 'user', content: buildUserPrompt(source, count) }]
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('model declined the rewrite request');
  }

  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock) throw new Error('no text block in response');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`unparseable response: ${err.message}`);
  }

  const byIndex = new Map();
  for (const item of parsed.variants || []) {
    if (item && Number.isInteger(item.index) && typeof item.text === 'string') {
      byIndex.set(item.index, normalizeTypography(item.text).trim());
    }
  }
  return byIndex;
}

/**
 * Generate `count` unique rewrites of `source`.
 *
 * Always resolves. Never throws: on any failure the corresponding slots come
 * back as nulls and the caller uses the original body.
 *
 * @returns {Promise<{variants: Array<string|null>, stats: object}>}
 *   variants[i] is the accepted rewrite for recipient i, or null to use source.
 */
async function generateVariants(source, count, options) {
  const opts = options || {};
  const stats = {
    requested: count,
    accepted: 0,
    rejected: 0,
    missing: 0,
    batches: 0,
    rejections: {},
    error: null
  };
  const variants = new Array(count).fill(null);

  const body = String(source == null ? '' : source).trim();
  if (!body || count <= 0) return { variants, stats };

  const anthropic = getClient(opts.apiKey);
  if (!anthropic) {
    stats.error = 'no API key configured';
    return { variants, stats };
  }

  const model = opts.model || DEFAULT_MODEL;
  const batchSize = Math.max(1, Math.min(50, opts.batchSize || DEFAULT_BATCH_SIZE));

  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    stats.batches++;

    let byIndex;
    try {
      byIndex = await requestBatch(anthropic, model, body, size);
    } catch (err) {
      // A failed batch is not a failed campaign. Record it, leave these slots
      // on the original body, and keep going: a transient error on batch 3
      // should not cost us the rewrites from batches 1, 2, 4, and 5.
      stats.error = err.message;
      stats.missing += size;
      console.warn(`[variation] batch at offset ${start} failed: ${err.message}`);
      continue;
    }

    for (let i = 0; i < size; i++) {
      const candidate = byIndex.get(i);
      if (candidate === undefined) {
        stats.missing++;
        continue;
      }
      const reason = rejectionReason(body, candidate, { placeholderWidths: opts.placeholderWidths });
      if (reason) {
        stats.rejected++;
        stats.rejections[reason] = (stats.rejections[reason] || 0) + 1;
        continue;
      }
      variants[start + i] = candidate;
      stats.accepted++;
    }
  }

  console.log(`[variation] ${stats.accepted}/${count} accepted ` +
    `(${stats.rejected} rejected, ${stats.missing} missing) in ${stats.batches} batch(es)`);
  return { variants, stats };
}

/**
 * Whether variation is configured and enabled.
 */
function isEnabled(settings) {
  return String(settings.variation_enabled) === '1' && !!settings.anthropic_api_key;
}

/**
 * Build the variant pool for one campaign.
 *
 * Returns the template itself at index 0 followed by every accepted rewrite,
 * which is the array the bulk insert paths consume. A pool of length 1 means no
 * variation happened, and the campaign behaves exactly as it does today.
 *
 * Always resolves. Variation is an optimisation, never a gate on sending.
 *
 * @param {string} template  The approved template, merge placeholders intact.
 * @param {object} settings  Row set from the settings table.
 */
async function buildPool(template, settings, options) {
  const opts = options || {};
  const body = String(template == null ? '' : template).trim();
  const pool = [body];
  const result = { pool, enabled: false, stats: null };

  if (!body || !isEnabled(settings || {})) return result;
  result.enabled = true;

  const poolSize = Math.max(1, Math.min(200, Number(settings.variation_pool_size) || 25));
  // Index 0 is the original, so only poolSize-1 rewrites are needed.
  const wanted = poolSize - 1;
  if (wanted < 1) return result;

  const { variants, stats } = await generateVariants(body, wanted, {
    apiKey: settings.anthropic_api_key,
    model: settings.variation_model || DEFAULT_MODEL,
    batchSize: Number(settings.variation_batch_size) || DEFAULT_BATCH_SIZE,
    // Widths measured from the real contact list, so segment checks reflect the
    // longest names and cities this campaign will actually merge in.
    placeholderWidths: opts.placeholderWidths
  });

  // Deduplicate: two batches can independently land on the same phrasing, and a
  // duplicate in the pool is a body that goes out twice as often as the rest.
  const seen = new Set([body.toLowerCase()]);
  for (const variant of variants) {
    if (!variant) continue;
    const key = variant.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(variant);
  }

  const merged = measureMerged(body, opts.placeholderWidths);
  result.stats = {
    ...stats,
    pool_size: pool.length,
    duplicates_dropped: stats.accepted - (pool.length - 1),
    // What one message actually costs at the widest merge values, which is the
    // figure to quote - not the template's own character count.
    merged_segments: merged.segments,
    merged_encoding: merged.encoding
  };
  return result;
}

module.exports = {
  generateVariants,
  buildPool,
  rejectionReason,
  normalizeTypography,
  measureMerged,
  fillPlaceholders,
  DEFAULT_PLACEHOLDER_WIDTHS,
  isEnabled,
  extractTokens,
  extractPlaceholders,
  DEFAULT_MODEL,
  DEFAULT_BATCH_SIZE
};
