'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { freshDb, seedConversation, seedMessage, utcStamp } = require('../helpers/testdb');

const ctx = freshDb('suppression');
const { db, raw } = ctx;
test.after(() => ctx.cleanup());

function newConversation(phone, name) {
  return db.getOrCreateConversation(phone, name).id;
}

function inbound(convId, body) {
  return db.insertMessage({
    conversation_id: convId, direction: 'inbound',
    from_number: '+15550000000', to_number: '8653456051',
    body, status: 'received'
  });
}

function outboundCount(convId) {
  return raw.prepare(
    "SELECT COUNT(*) c FROM messages WHERE conversation_id = ? AND direction = 'outbound'"
  ).get(convId).c;
}

/* ---------------- opt-out persistence ---------------- */

test('an inbound STOP permanently records an opt-out', () => {
  const id = newConversation('+15551110001', 'Stopper');
  inbound(id, 'STOP');

  const conv = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  assert.strictEqual(conv.opted_out, 1);
  assert.strictEqual(conv.opt_out_source, 'inbound_keyword');
  assert.strictEqual(conv.opt_out_text, 'STOP');
  assert.ok(conv.opted_out_at, 'opted_out_at must be stamped');
  assert.strictEqual(conv.suppression_reason, 'opted_out');
});

test('a LATER inbound message does not erase the opt-out', () => {
  const id = newConversation('+15551110002', 'Chatty');
  inbound(id, 'STOP');
  inbound(id, 'Actually wait, tell me more!');
  inbound(id, 'Yes I am very interested');

  const conv = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  assert.strictEqual(conv.opted_out, 1, 'still suppressed after later messages');
  assert.strictEqual(conv.opt_out_text, 'STOP', 'original opt-out message preserved');
  // The display classification tracks the newest reply without weakening suppression.
  assert.strictEqual(conv.reply_classification, 'positive');
  assert.ok(db.getSuppressionBlock(id, { scope: 'individual' }));
});

test('the first opt-out wins; a second STOP does not overwrite the audit trail', () => {
  const id = newConversation('+15551110003', 'Twice');
  inbound(id, 'STOP');
  const first = raw.prepare('SELECT opted_out_at, opt_out_text FROM conversations WHERE id = ?').get(id);
  inbound(id, 'UNSUBSCRIBE');
  const second = raw.prepare('SELECT opted_out_at, opt_out_text FROM conversations WHERE id = ?').get(id);
  assert.deepStrictEqual(second, first);
});

test('a plain "No thanks" does NOT opt the contact out', () => {
  const id = newConversation('+15551110004', 'Polite');
  inbound(id, 'No thanks');

  const conv = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  assert.strictEqual(conv.opted_out, 0, 'disinterest is not a legal opt-out');
  assert.strictEqual(conv.reply_classification, 'negative');
  assert.strictEqual(db.getSuppressionBlock(id, { scope: 'individual' }), null);
});

test('a wrong-number reply suppresses separately from opt-out', () => {
  const id = newConversation('+15551110005', 'Stranger');
  inbound(id, 'wrong number');

  const conv = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  assert.strictEqual(conv.wrong_number, 1);
  assert.strictEqual(conv.opted_out, 0, 'wrong number is not an opt-out');
  const block = db.getSuppressionBlock(id, { scope: 'individual' });
  assert.strictEqual(block.reason, 'wrong_number');
});

/* ---------------- enforcement across outbound paths ---------------- */

test('bulk message is blocked for an opted-out contact', () => {
  const id = newConversation('+15551110010', 'Bulk');
  inbound(id, 'STOP');
  const before = outboundCount(id);

  const result = db.sendBulkMessages([id], 'Hi [Name]!', '8653456051');
  assert.strictEqual(result.messages.length, 0);
  assert.strictEqual(result.skipped[0].reason, 'opted_out');
  assert.strictEqual(outboundCount(id), before, 'no message row created');
});

test('campaign path (same function) is blocked', () => {
  const id = newConversation('+15551110011', 'Campaign');
  inbound(id, 'unsubscribe');

  // An inbound reply moves the contact to the '-Responded' substage, so target
  // the stage the contact is actually in — this mirrors what /api/campaigns does.
  const stage = raw.prepare('SELECT stage FROM conversations WHERE id = ?').get(id).stage;
  const ids = raw.prepare('SELECT id FROM conversations WHERE stage = ?').all(stage).map(r => r.id);
  assert.ok(ids.includes(id), 'the opted-out contact is inside the campaign target set');

  const result = db.sendBulkMessages(ids, 'Campaign blast', '8653456051');
  assert.ok(!result.messages.some(m => m.conversation_id === id));
  assert.ok(result.skipped.some(s => s.id === id && s.reason === 'opted_out'));
});

test('each blocked disposition is skipped by bulk sends', () => {
  const cases = [
    ['no', 'disposition_no'],
    ['unqualified', 'disposition_unqualified'],
    ['customer', 'disposition_customer']
  ];
  cases.forEach(([disposition, expectedReason], i) => {
    const id = newConversation(`+1555111002${i}`, `Dispo ${disposition}`);
    db.setConversationDisposition(id, disposition);
    const result = db.sendBulkMessages([id], 'blast', '8653456051');
    assert.strictEqual(result.messages.length, 0, `${disposition} must be skipped`);
    assert.strictEqual(result.skipped[0].reason, expectedReason);
  });
});

test('an appointment contact is NOT blocked from bulk sends', () => {
  const id = newConversation('+15551110030', 'Booked');
  db.setConversationDisposition(id, 'appointment', utcStamp(60 * 24));
  const result = db.sendBulkMessages([id], 'reminder', '8653456051');
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.skipped.length, 0);
});

test('CSV import queues nothing for a suppressed contact and does not reset the stage', () => {
  const id = newConversation('+15551110040', 'Imported');
  raw.prepare("UPDATE conversations SET stage = 'Stage 3' WHERE id = ?").run(id);
  inbound(id, 'take me off your list');
  const before = outboundCount(id);
  const stageBefore = raw.prepare('SELECT stage FROM conversations WHERE id = ?').get(id).stage;

  const result = db.bulkImportLeads(
    [{ phone_number: '+15551110040', name: 'Imported' }],
    'Hello [Name], free inspection?',
    '8653456051'
  );

  assert.strictEqual(result.messages_queued, 0);
  assert.strictEqual(result.skipped_opted_out, 1);
  assert.strictEqual(outboundCount(id), before);

  const stageAfter = raw.prepare('SELECT stage FROM conversations WHERE id = ?').get(id).stage;
  assert.strictEqual(stageAfter, stageBefore, 'reimport must leave a suppressed contact\'s stage untouched');
  assert.ok(!stageAfter.startsWith('Stage 1'), 'and must not reset it to Stage 1');
});

test('individual send scope blocks hard suppression but allows dispositions', () => {
  const optedOut = newConversation('+15551110050', 'Hard');
  inbound(optedOut, 'STOP');
  assert.ok(db.getSuppressionBlock(optedOut, { scope: 'individual' }), 'opt-out blocks individual send');

  const customer = newConversation('+15551110051', 'Soft');
  db.setConversationDisposition(customer, 'customer');
  assert.strictEqual(db.getSuppressionBlock(customer, { scope: 'individual' }), null,
    'a customer may still be messaged one to one');
  assert.ok(db.getSuppressionBlock(customer, { scope: 'bulk' }), 'but not blasted');
});

test('a queued message is cancelled at dequeue if the contact opts out first', () => {
  const id = newConversation('+15551110060', 'Racer');

  // Queue a message while the contact is still contactable.
  const msgId = raw.prepare(`
    INSERT INTO messages (conversation_id, direction, from_number, to_number, body, status)
    VALUES (?, 'outbound', 'a', 'b', 'queued before opt-out', 'queued')
  `).run(id).lastInsertRowid;

  // They opt out before the queue reaches it.
  inbound(id, 'STOP');

  const queued = raw.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  const block = db.cancelIfSuppressed(queued);

  assert.ok(block, 'dequeue must refuse to send');
  const after = raw.prepare('SELECT status, error_message FROM messages WHERE id = ?').get(msgId);
  assert.strictEqual(after.status, 'failed');
  assert.match(after.error_message, /Blocked before send/);
});

test('a retry cannot bypass suppression because the message never leaves the queue', () => {
  const id = newConversation('+15551110061', 'Retry');
  inbound(id, 'STOP');
  const msgId = raw.prepare(`
    INSERT INTO messages (conversation_id, direction, from_number, to_number, body, status)
    VALUES (?, 'outbound', 'a', 'b', 'retry attempt', 'queued')
  `).run(id).lastInsertRowid;

  // Simulate the worker picking it up repeatedly.
  for (let i = 0; i < 3; i++) {
    const msg = raw.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (msg.status === 'queued') db.cancelIfSuppressed(msg);
  }
  assert.strictEqual(raw.prepare('SELECT status FROM messages WHERE id = ?').get(msgId).status, 'failed');
});

/* ---------------- re-opt-in ---------------- */

test('re-opt-in requires an actor and clears suppression', () => {
  const id = newConversation('+15551110070', 'Returner');
  inbound(id, 'STOP');
  assert.throws(() => db.recordOptIn(id, null), /requires an actor/);

  const updated = db.recordOptIn(id, 'jimbo');
  assert.strictEqual(updated.opted_out, 0);
  assert.strictEqual(updated.opted_in_by, 'jimbo');
  assert.ok(updated.opted_in_at);
  assert.strictEqual(db.getSuppressionBlock(id, { scope: 'individual' }), null);

  const result = db.sendBulkMessages([id], 'welcome back', '8653456051');
  assert.strictEqual(result.messages.length, 1, 'sending is allowed after re-opt-in');
});

test('clearing a disposition does NOT clear an opt-out', () => {
  const id = newConversation('+15551110080', 'Both');
  inbound(id, 'STOP');
  db.setConversationDisposition(id, 'no');
  db.setConversationDisposition(id, null); // undo

  const conv = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  assert.strictEqual(conv.disposition, null, 'disposition cleared');
  assert.strictEqual(conv.opted_out, 1, 'opt-out survives the undo');
  assert.ok(db.getSuppressionBlock(id, { scope: 'individual' }));
});

test('setting a disposition does not clear an opt-out', () => {
  const id = newConversation('+15551110081', 'Dispo');
  inbound(id, 'STOP');
  db.setConversationDisposition(id, 'appointment', utcStamp(60 * 48));
  const conv = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  assert.strictEqual(conv.opted_out, 1);
});

/* ---------------- audit trail ---------------- */

test('blocked sends and opt-outs are written to the audit log', () => {
  const id = newConversation('+15551110090', 'Audited');
  inbound(id, 'STOP');
  db.sendBulkMessages([id], 'blast', '8653456051');

  const events = raw.prepare(
    'SELECT event, reason FROM suppression_events WHERE conversation_id = ? ORDER BY id'
  ).all(id);
  assert.ok(events.some(e => e.event === 'opt_out'), 'opt-out recorded');
  const optIn = db.recordOptIn(id, 'tester');
  assert.ok(optIn);
  const after = raw.prepare(
    "SELECT event FROM suppression_events WHERE conversation_id = ? AND event = 'opt_in'"
  ).all(id);
  assert.strictEqual(after.length, 1);
});
