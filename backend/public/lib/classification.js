/**
 * Canonical inbound-reply classification.
 *
 * THIS IS THE ONLY PLACE reply keywords are defined. The server requires it
 * directly; the browser loads the same file as a plain <script> (see the UMD
 * shim at the bottom) and reads window.SmsClassification. Do not copy these
 * lists anywhere else — two lists silently drift and then enforcement and the
 * UI disagree about who is suppressed.
 *
 * A reply gets exactly one classification:
 *
 *   opt_out       Legally significant. The contact demanded no further contact.
 *                 Triggers permanent suppression.
 *   wrong_number  We are texting the wrong person. Suppressed, but for a
 *                 different reason and reported separately.
 *   negative      Not interested. A business signal, NOT a legal opt-out.
 *                 Does not by itself suppress.
 *   positive      Anything still engaged: questions, maybes, callback times.
 *   unknown       Empty or attachment-only. Needs human review.
 *
 * "No thanks" is deliberately NOT an opt-out. Conflating disinterest with a
 * legal opt-out both over-suppresses reachable leads and muddies the audit
 * trail for the opt-outs that actually matter.
 */

'use strict';

const CLASSIFICATIONS = {
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  OPT_OUT: 'opt_out',
  WRONG_NUMBER: 'wrong_number',
  UNKNOWN: 'unknown'
};

// Human-facing labels. The UI must never call a plain "no thanks" an opt-out.
const CLASSIFICATION_LABELS = {
  positive: 'Positive Reply',
  negative: 'Not Interested',
  opt_out: 'Opted Out',
  wrong_number: 'Wrong Number',
  unknown: 'Needs Review'
};

/* ---------------------------------------------------------------- *
 * Legal opt-out
 * ---------------------------------------------------------------- */

// Carrier-standard opt-out keywords: the whole reply must be one of these.
const OPT_OUT_EXACT = [
  'stop', 'stopall', 'stop all', 'stopquit', 'unsubscribe', 'unsub',
  'cancel', 'end', 'quit', 'optout', 'opt out', 'revoke', 'remove',
  'remove me', 'delete me', 'take me off', 'unsubscribe me'
];

// Opt-out demands that stay opt-outs regardless of surrounding words.
const OPT_OUT_PHRASES = [
  'remove me from your list', 'remove me from the list', 'remove me from your',
  'remove my number', 'remove this number', 'delete my number',
  'take me off your list', 'take me off the list', 'take me off your',
  'take me off of your', 'off your list', 'off of your list',
  'stop texting', 'stop messaging', 'stop contacting', 'stop calling',
  'stop sending', 'quit texting', 'quit messaging',
  'do not text', 'dont text', 'do not contact', 'dont contact',
  'do not call', 'dont call', 'do not message', 'dont message',
  'never text', 'never contact', 'never call',
  'lose my number', 'loose my number',
  'unsubscribe', 'opt me out', 'opt out',
  'leave me alone', 'no longer wish to receive', 'stop all messages'
];

/* ---------------------------------------------------------------- *
 * Wrong number
 * ---------------------------------------------------------------- */

const WRONG_NUMBER_EXACT = ['wrong number', 'wrong person', 'wrong guy', 'wrong gal'];

// Unambiguous anywhere in a message.
const WRONG_NUMBER_PHRASES = [
  'wrong number', 'wrong person', 'you have the wrong', 'you got the wrong',
  'have the wrong number', 'got the wrong number',
  'nobody here by that name', 'no one here by that name',
  'there is no one here', 'theres no one here', 'never heard of'
];

// Only meaningful in a SHORT reply. "This is not John" is a wrong number;
// "this is not what I expected, tell me more" is not. Likewise "I am not"
// would otherwise swallow "I am not sure, send details".
const WRONG_NUMBER_SHORT_PHRASES = [
  'this is not', 'not my name', 'thats not me', 'that is not me',
  'i am not', 'im not'
];
const WRONG_NUMBER_SHORT_MAX_WORDS = 6;

/* ---------------------------------------------------------------- *
 * Negative but reachable
 * ---------------------------------------------------------------- */

const NEGATIVE_EXACT = [
  'no', 'nope', 'nah', 'na', 'naw', 'no thanks', 'no thank you', 'no thx',
  'nope thanks', 'not interested', 'no interest', 'pass', 'hard pass',
  'maybe not', 'never', 'no way', 'not now', 'not today', 'not at this time',
  'go away', 'fuck off', 'fuck you', 'f off', 'piss off', 'get lost'
];

const NEGATIVE_PHRASES = [
  'not interested', 'no longer interested', 'not looking', 'im good',
  'i am good', 'all set', 'were all set', 'we are all set',
  'no thank you', 'not right now', 'not at this time', 'already have',
  'fuck off', 'fuck you', 'piss off'
];

/**
 * Fold a reply down to a comparable form: lowercase, punctuation and emoji
 * stripped, apostrophes removed so "don't" and "dont" match, runs of
 * whitespace collapsed.
 */
function normalizeReply(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[‘’']/g, '')       // curly + straight apostrophes
    .replace(/[^a-z0-9\s]/g, ' ')          // punctuation and emoji
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesExact(normalized, list) {
  return list.includes(normalized);
}

function matchesPhrase(normalized, list) {
  return list.some(phrase => normalized.includes(phrase));
}

/**
 * Short replies that merely lead with a keyword, e.g. "stop please" or
 * "no thanks man". Long messages are excluded so that a sentence merely
 * containing the word "no" is not mistaken for a rejection.
 */
function leadsWith(normalized, list, maxWords) {
  const words = normalized.split(' ');
  if (words.length > maxWords) return false;
  return list.includes(words[0]);
}

// "stop" means something else entirely in these; do not treat them as opt-outs.
const STOP_FALSE_FRIENDS = ['stop by', 'stop in', 'stop over', 'stop out', 'bus stop', 'stop light'];

/**
 * A keyword ANYWHERE inside a short reply, so "actually STOP" and "ok stop"
 * are caught, not just replies that begin with the keyword.
 *
 * Deliberately biased towards over-suppression: wrongly suppressing someone
 * who wrote "stop by" costs one lead, while missing a real "stop" is a legal
 * violation. The false-friend list keeps the common innocent cases out.
 */
function containsKeyword(normalized, list, maxWords) {
  const words = normalized.split(' ');
  if (words.length > maxWords) return false;
  if (STOP_FALSE_FRIENDS.some(phrase => normalized.includes(phrase))) return false;
  return words.some(word => list.includes(word));
}

/**
 * Classify a single inbound message body.
 * Returns one of the CLASSIFICATIONS values.
 *
 * Order matters: opt-out beats wrong number beats negative. A message that
 * says both "wrong number, stop texting me" is an opt-out, which is the
 * safer of the two.
 */
function classifyReply(text) {
  const raw = String(text == null ? '' : text).trim();
  const normalized = normalizeReply(text);

  // Genuinely empty, or attachment-only, needs a human to look at it.
  if (!raw) return CLASSIFICATIONS.UNKNOWN;

  // Content that survives trimming but has no letters or digits — "?", "!!",
  // a lone emoji. Someone did reply, so treat it as engagement rather than
  // hiding it in Needs Review.
  if (!normalized) return CLASSIFICATIONS.POSITIVE;

  const wordCount = normalized.split(' ').length;

  if (matchesExact(normalized, OPT_OUT_EXACT) ||
      matchesPhrase(normalized, OPT_OUT_PHRASES) ||
      containsKeyword(normalized, OPT_OUT_EXACT, 4)) {
    return CLASSIFICATIONS.OPT_OUT;
  }

  if (matchesExact(normalized, WRONG_NUMBER_EXACT) ||
      matchesPhrase(normalized, WRONG_NUMBER_PHRASES) ||
      (wordCount <= WRONG_NUMBER_SHORT_MAX_WORDS &&
       matchesPhrase(normalized, WRONG_NUMBER_SHORT_PHRASES))) {
    return CLASSIFICATIONS.WRONG_NUMBER;
  }

  if (matchesExact(normalized, NEGATIVE_EXACT) ||
      matchesPhrase(normalized, NEGATIVE_PHRASES) ||
      leadsWith(normalized, NEGATIVE_EXACT, 4)) {
    return CLASSIFICATIONS.NEGATIVE;
  }

  return CLASSIFICATIONS.POSITIVE;
}

/** True only for legally significant opt-out language. */
function isOptOut(text) {
  return classifyReply(text) === CLASSIFICATIONS.OPT_OUT;
}

/** True only for wrong-number language. */
function isWrongNumber(text) {
  return classifyReply(text) === CLASSIFICATIONS.WRONG_NUMBER;
}

/** Label shown in the UI for a classification value. */
function labelFor(classification) {
  return CLASSIFICATION_LABELS[classification] || CLASSIFICATION_LABELS.unknown;
}

const api = {
  CLASSIFICATIONS,
  CLASSIFICATION_LABELS,
  normalizeReply,
  classifyReply,
  isOptOut,
  isWrongNumber,
  labelFor
};

// Node (server + tests) and browser (<script src="lib/classification.js">)
// both consume this same file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.SmsClassification = api;
}
