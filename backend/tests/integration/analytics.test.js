'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { freshDb, seedConversation, seedMessage } = require('../helpers/testdb');

const ctx = freshDb('analytics');
const { db, raw } = ctx;
test.after(() => ctx.cleanup());

const IN_RANGE_A = '2026-07-10';
const IN_RANGE_B = '2026-07-20';
const OUTSIDE = '2026-06-01';
const FROM = '2026-07-01';
const TO = '2026-07-31';

// Deterministic fixture built directly in SQL so nothing depends on app paths.
const alice = seedConversation(raw, { phone: '+15554440001', name: 'Alice', createdAt: `${IN_RANGE_A} 08:00:00` });
const bob = seedConversation(raw, { phone: '+15554440002', name: 'Bob', createdAt: `${IN_RANGE_A} 08:00:00` });
const cara = seedConversation(raw, { phone: '+15554440003', name: 'Cara', createdAt: `${IN_RANGE_B} 08:00:00` });
const old = seedConversation(raw, { phone: '+15554440004', name: 'Old', createdAt: `${OUTSIDE} 08:00:00` });

// Outbound: 3 accepted (1 with a real DLR), 1 failed, 1 queued — plus 1 outside the range.
seedMessage(raw, { conversationId: alice, direction: 'outbound', status: 'sent', createdAt: `${IN_RANGE_A} 09:00:00`, deliveredAt: `${IN_RANGE_A} 09:00:30` });
seedMessage(raw, { conversationId: bob, direction: 'outbound', status: 'sent', createdAt: `${IN_RANGE_A} 09:00:00` });
seedMessage(raw, { conversationId: cara, direction: 'outbound', status: 'sent', createdAt: `${IN_RANGE_B} 09:00:00` });
seedMessage(raw, { conversationId: alice, direction: 'outbound', status: 'failed', createdAt: `${IN_RANGE_A} 10:00:00` });
seedMessage(raw, { conversationId: bob, direction: 'outbound', status: 'queued', createdAt: `${IN_RANGE_B} 09:00:00` });
seedMessage(raw, { conversationId: old, direction: 'outbound', status: 'sent', createdAt: `${OUTSIDE} 09:00:00` });

// Inbound: Alice replies positively TWICE (the inflation trap), Bob opts out,
// Cara asks a question, and one reply sits outside the range.
seedMessage(raw, { conversationId: alice, direction: 'inbound', body: 'Yes what time works?', createdAt: `${IN_RANGE_A} 09:30:00` });
seedMessage(raw, { conversationId: alice, direction: 'inbound', body: 'still interested!', createdAt: `${IN_RANGE_A} 11:00:00` });
seedMessage(raw, { conversationId: bob, direction: 'inbound', body: 'STOP', createdAt: `${IN_RANGE_A} 09:45:00` });
seedMessage(raw, { conversationId: cara, direction: 'inbound', body: 'how much?', createdAt: `${IN_RANGE_B} 14:00:00` });
seedMessage(raw, { conversationId: old, direction: 'inbound', body: 'ignore me', createdAt: `${OUTSIDE} 09:30:00` });

raw.prepare("UPDATE conversations SET disposition='appointment', disposition_at=? WHERE id=?").run(`${IN_RANGE_A} 12:00:00`, alice);
raw.prepare("UPDATE conversations SET disposition='customer', disposition_at=? WHERE id=?").run(`${IN_RANGE_B} 12:00:00`, cara);
raw.prepare("UPDATE conversations SET disposition='no', disposition_at=? WHERE id=?").run(`${OUTSIDE} 12:00:00`, old);
raw.prepare("UPDATE conversations SET opted_out=1, opted_out_at=? WHERE id=?").run(`${IN_RANGE_A} 09:45:00`, bob);

const stats = db.getStats(FROM, TO);

test('outbound counts exclude messages outside the range', () => {
  assert.strictEqual(stats.sent.attempted, 5);
  assert.strictEqual(stats.sent.carrier_accepted, 3);
  assert.strictEqual(stats.sent.failed, 1);
  assert.strictEqual(stats.sent.queued, 1);
});

test('"delivered" means a real delivery receipt, not carrier acceptance', () => {
  assert.strictEqual(stats.sent.delivered, 1, 'only the message with delivered_at counts');
  assert.strictEqual(stats.sent.carrier_accepted, 3);
  assert.strictEqual(stats.sent.unknown_delivery, 2, 'accepted but never confirmed');
  assert.notStrictEqual(stats.sent.delivered, stats.sent.carrier_accepted,
    'the two must never be conflated');
});

test('acceptance and confirmed-delivery rates use their stated denominators', () => {
  // accepted / (accepted + failed) = 3/4
  assert.strictEqual(stats.sent.acceptance_rate, 75);
  // delivered / accepted = 1/3
  assert.strictEqual(stats.sent.confirmed_delivery_rate, 33.3);
});

test('unique responders are counted separately from messages', () => {
  assert.strictEqual(stats.responses.total_messages, 4, 'four inbound messages');
  assert.strictEqual(stats.responses.unique_responders, 3, 'from three people');
});

test('multiple positive messages from one contact do not inflate the contact count', () => {
  assert.strictEqual(stats.responses.positive_messages, 3, 'Alice x2 + Cara x1');
  assert.strictEqual(stats.responses.positive_contacts, 2, 'but only two people');
});

test('opt-outs are counted separately from ordinary negatives', () => {
  assert.strictEqual(stats.responses.opt_out_messages, 1);
  assert.strictEqual(stats.responses.opt_out_contacts, 1);
  assert.strictEqual(stats.responses.negative_messages, 0, 'STOP is an opt-out, not a negative');
  assert.strictEqual(stats.responses.negative_contacts, 0);
});

// Temporary fixtures are removed in `finally` so a failed assertion cannot
// leak rows into the shared dataset the later tests assert against.
function withTempConversation(phone, build, assertions) {
  const id = seedConversation(raw, { phone, createdAt: `${IN_RANGE_A} 08:00:00` });
  try {
    build(id);
    assertions(id);
  } finally {
    raw.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    raw.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }
}

test('a contact is ranked by their strongest signal', () => {
  withTempConversation('+15554449999', id => {
    seedMessage(raw, { conversationId: id, direction: 'outbound', status: 'sent', createdAt: `${IN_RANGE_A} 09:00:00` });
    seedMessage(raw, { conversationId: id, direction: 'inbound', body: 'sounds great', createdAt: `${IN_RANGE_A} 09:10:00` });
    seedMessage(raw, { conversationId: id, direction: 'inbound', body: 'actually STOP', createdAt: `${IN_RANGE_A} 09:20:00` });
  }, () => {
    const s = db.getStats(FROM, TO);
    assert.strictEqual(s.responses.opt_out_contacts, 2, 'the opt-out outranks their earlier positive');
    assert.strictEqual(s.responses.positive_contacts, 2, 'and they are not also counted as positive');
  });
});

test('response rate uses contacts whose message the carrier accepted', () => {
  // 3 responders / 3 contacts accepted
  assert.strictEqual(stats.sent.contacts_accepted, 3);
  assert.strictEqual(stats.responses.response_rate, 100);
});

test('positive rates state which denominator they use', () => {
  // 2 positive contacts / 3 responders
  assert.strictEqual(stats.responses.positive_rate_of_responders, 66.7);
  // 2 positive contacts / 3 contacts accepted
  assert.strictEqual(stats.responses.positive_rate_of_contacted, 66.7);
  assert.ok(stats.rate_definitions.positive_rate_of_responders.includes('replied'));
  assert.ok(stats.rate_definitions.positive_rate_of_contacted.includes('carrier accepted'));
});

test('every rate has a published definition', () => {
  ['acceptance_rate', 'confirmed_delivery_rate', 'response_rate',
   'positive_rate_of_responders', 'positive_rate_of_contacted',
   'negative_rate_of_responders', 'opt_out_rate_of_contacted'].forEach(key => {
    assert.ok(stats.rate_definitions[key], `${key} must be documented`);
  });
});

test('dispositions are attributed to the window they were set in', () => {
  assert.strictEqual(stats.dispositions.appointment, 1);
  assert.strictEqual(stats.dispositions.customer, 1);
  assert.strictEqual(stats.dispositions.no, 0, 'the out-of-range disposition is excluded');
});

test('suppression recorded in the window is reported', () => {
  assert.strictEqual(stats.suppression.opt_outs_recorded, 1);
});

test('new leads count conversations created in the window', () => {
  assert.strictEqual(stats.new_leads, 3, 'Old was created before the range');
});

test('the daily series covers only days with activity', () => {
  assert.strictEqual(stats.daily.length, 2);
  assert.deepStrictEqual(stats.daily[0], { day: IN_RANGE_A, sent: 2, failed: 1, replies: 3 });
  assert.deepStrictEqual(stats.daily[1], { day: IN_RANGE_B, sent: 1, failed: 0, replies: 1 });
});

test('average reply time is positive and plausible', () => {
  assert.strictEqual(typeof stats.avg_reply_minutes, 'number');
  assert.ok(stats.avg_reply_minutes > 0, 'never negative');
  assert.ok(stats.avg_reply_minutes < 60 * 24);
});

test('peak reply hour is the hour with the most inbound messages', () => {
  assert.strictEqual(stats.peak_reply_hour, 9, 'three of four replies land in hour 09');
});

test('date boundaries are inclusive on both ends', () => {
  const single = db.getStats(IN_RANGE_A, IN_RANGE_A);
  assert.strictEqual(single.daily.length, 1);
  assert.strictEqual(single.sent.attempted, 3);

  const justBefore = db.getStats('2026-07-01', '2026-07-09');
  assert.strictEqual(justBefore.sent.attempted, 0, 'the day before the first message is empty');
});

test('an empty range returns clean zeros, not nulls', () => {
  const empty = db.getStats('2020-01-01', '2020-01-02');
  assert.strictEqual(empty.sent.attempted, 0);
  assert.strictEqual(empty.sent.delivered, 0);
  assert.strictEqual(empty.sent.acceptance_rate, 0);
  assert.strictEqual(empty.sent.confirmed_delivery_rate, 0);
  assert.strictEqual(empty.responses.total_messages, 0);
  assert.strictEqual(empty.responses.response_rate, 0);
  assert.strictEqual(empty.responses.positive_contacts, 0);
  assert.strictEqual(empty.daily.length, 0);
  assert.strictEqual(empty.new_leads, 0);
  assert.strictEqual(empty.avg_reply_minutes, null, 'null, not NaN');
  assert.strictEqual(empty.peak_reply_hour, null);
});

test('an inbound reply with no preceding outbound does not poison the average', () => {
  withTempConversation('+15554448888', id => {
    seedMessage(raw, { conversationId: id, direction: 'inbound', body: 'unsolicited', createdAt: `${IN_RANGE_A} 09:00:00` });
  }, () => {
    const s = db.getStats(FROM, TO);
    assert.ok(s.avg_reply_minutes > 0 && Number.isFinite(s.avg_reply_minutes),
      'the NULL gap is excluded rather than producing NaN');
  });
});
