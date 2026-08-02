'use strict';

const test = require('node:test');
const assert = require('node:assert');
const c = require('../../public/lib/classification');

const { OPT_OUT, NEGATIVE, WRONG_NUMBER, POSITIVE, UNKNOWN } = c.CLASSIFICATIONS;

function expect(input, expected) {
  assert.strictEqual(
    c.classifyReply(input), expected,
    `${JSON.stringify(input)} should classify as ${expected}, got ${c.classifyReply(input)}`
  );
}

test('explicit opt-out keywords', () => {
  ['STOP', 'stop', 'Stop', 'STOPALL', 'stop all', 'UNSUBSCRIBE', 'unsubscribe',
   'CANCEL', 'END', 'QUIT', 'remove', 'Remove me', 'take me off',
   'opt out', 'OPTOUT', 'revoke', 'delete me'].forEach(t => expect(t, OPT_OUT));
});

test('explicit opt-out phrases', () => {
  ['Please remove me from your list', 'take me off your list',
   'Take me off the list please', 'do not contact me', "don't contact me",
   'do not text me again', "don't text me", 'stop texting me',
   'stop messaging me please', 'lose my number', 'Lose my number!',
   'I want to unsubscribe', 'opt me out', 'leave me alone',
   'never contact me again', 'quit texting me'].forEach(t => expect(t, OPT_OUT));
});

test('negative replies are NOT legal opt-outs', () => {
  ['No', 'no', 'NO', 'nope', 'nah', 'naw', 'No thanks', 'no thank you',
   'Not interested', 'not interested thanks', 'pass', 'hard pass',
   'maybe not', 'no way', 'not now', 'not today', "I'm good",
   'we are all set', 'already have one'].forEach(t => expect(t, NEGATIVE));
});

test('wrong number replies', () => {
  ['Wrong number', 'wrong number!', 'You have the wrong person',
   'you got the wrong number', 'This is not John', 'Nobody here by that name',
   'no one here by that name', 'wrong person'].forEach(t => expect(t, WRONG_NUMBER));
});

test('positive replies', () => {
  ['Yes! What time works for you?', 'how much does it cost?', '?',
   'Maybe next month, call me in June', 'Sounds good, send me the details',
   'Sure', 'Tell me more', 'ok', 'Call me at 3', 'interested'].forEach(t => expect(t, POSITIVE));
});

test('empty and attachment-only replies need review', () => {
  ['', '   ', null, undefined].forEach(t => expect(t, UNKNOWN));
});

test('punctuation does not defeat matching', () => {
  ['STOP.', 'STOP!', 'stop!!!', '"STOP"', '(stop)', 'stop...',
   'Unsubscribe.', '- remove me -'].forEach(t => expect(t, OPT_OUT));
});

test('capitalisation does not defeat matching', () => {
  ['StOp', 'UnSuBsCrIbE', 'ReMoVe Me'].forEach(t => expect(t, OPT_OUT));
});

test('emoji do not defeat matching', () => {
  expect('STOP 🛑', OPT_OUT);
  expect('no thanks 👍', NEGATIVE);
  expect('Yes please 😊', POSITIVE);
});

test('curly and straight apostrophes both match', () => {
  expect("don't text me", OPT_OUT);
  expect('don’t text me', OPT_OUT);
  expect('dont text me', OPT_OUT);
});

test('extra whitespace is collapsed', () => {
  expect('   STOP   ', OPT_OUT);
  expect('remove    me', OPT_OUT);
  expect('no    thanks', NEGATIVE);
});

test('a long sentence containing "no" is not a rejection', () => {
  expect('There is no problem at all, I would love to hear more about this', POSITIVE);
});

test('a long sentence containing "stop" is still an opt-out only via phrases', () => {
  // "stop by" is not an opt-out demand
  expect('Can you stop by the house on Tuesday afternoon to take a look', POSITIVE);
  // but an explicit demand anywhere in the message is
  expect('Hi there, please stop texting me about this', OPT_OUT);
});

test('opt-out beats wrong number when a reply says both', () => {
  expect('wrong number, stop texting me', OPT_OUT);
});

test('labels never call a plain negative an opt-out', () => {
  assert.strictEqual(c.labelFor(NEGATIVE), 'Not Interested');
  assert.strictEqual(c.labelFor(OPT_OUT), 'Opted Out');
  assert.strictEqual(c.labelFor(WRONG_NUMBER), 'Wrong Number');
  assert.strictEqual(c.labelFor(POSITIVE), 'Positive Reply');
  assert.strictEqual(c.labelFor(UNKNOWN), 'Needs Review');
});

test('isOptOut is true only for legal opt-outs', () => {
  assert.strictEqual(c.isOptOut('STOP'), true);
  assert.strictEqual(c.isOptOut('No thanks'), false);
  assert.strictEqual(c.isOptOut('wrong number'), false);
  assert.strictEqual(c.isOptOut('Yes!'), false);
});

test('isWrongNumber is true only for wrong-number replies', () => {
  assert.strictEqual(c.isWrongNumber('wrong number'), true);
  assert.strictEqual(c.isWrongNumber('STOP'), false);
});

test('an opt-out keyword anywhere in a SHORT reply still counts', () => {
  ['actually STOP', 'ok stop', 'please unsubscribe', 'just remove me',
   'yeah cancel', 'ugh stop'].forEach(t => expect(t, OPT_OUT));
});

test('innocent uses of stop are not opt-outs', () => {
  expect('stop by', POSITIVE);
  expect('stop by tomorrow', POSITIVE);
  expect('can you stop over', POSITIVE);
  expect('Can you stop by the house on Tuesday afternoon', POSITIVE);
});

test('a long message is not opted out by a stray keyword', () => {
  expect('I had to cancel my other appointment so this week works well for me', POSITIVE);
});
