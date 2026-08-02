'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { freshDb, utcStamp } = require('../helpers/testdb');

const ctx = freshDb('dispositions');
const { db, raw } = ctx;
test.after(() => ctx.cleanup());

let seq = 0;
function newConversation(name) {
  seq++;
  return db.getOrCreateConversation(`+1555222${String(seq).padStart(4, '0')}`, name).id;
}

test('every valid disposition saves', () => {
  db.VALID_DISPOSITIONS.forEach(disposition => {
    const id = newConversation(`Valid ${disposition}`);
    const needsDate = disposition === 'appointment' || disposition === 'follow_up';
    const updated = db.setConversationDisposition(
      id, disposition, needsDate ? utcStamp(60 * 24) : null
    );
    assert.strictEqual(updated.disposition, disposition);
    assert.ok(updated.disposition_at, 'disposition_at stamped');
  });
});

test('an invalid disposition is rejected', () => {
  const id = newConversation('Invalid');
  assert.throws(() => db.setConversationDisposition(id, 'banana'), /Invalid disposition/);
  assert.throws(() => db.setConversationDisposition(id, 'APPOINTMENT'), /Invalid disposition/);
});

test('appointment requires a datetime', () => {
  const id = newConversation('NoDate');
  assert.throws(() => db.setConversationDisposition(id, 'appointment', null),
    /date and time is required/);
  assert.throws(() => db.setConversationDisposition(id, 'appointment', ''),
    /date and time is required/);
});

test('follow_up requires a datetime', () => {
  const id = newConversation('NoDate2');
  assert.throws(() => db.setConversationDisposition(id, 'follow_up', null),
    /date and time is required/);
});

test('non-scheduled dispositions never keep a schedule', () => {
  const id = newConversation('Cleared');
  db.setConversationDisposition(id, 'appointment', utcStamp(60 * 24));
  assert.ok(raw.prepare('SELECT scheduled_at FROM conversations WHERE id = ?').get(id).scheduled_at);

  const updated = db.setConversationDisposition(id, 'no', utcStamp(60 * 24));
  assert.strictEqual(updated.scheduled_at, null, 'a "No" carries no appointment time');
});

test('clearing a disposition resets the fields', () => {
  const id = newConversation('Undo');
  db.setConversationDisposition(id, 'appointment', utcStamp(60 * 24), 'bring pricing');
  const cleared = db.setConversationDisposition(id, null);
  assert.strictEqual(cleared.disposition, null);
  assert.strictEqual(cleared.disposition_at, null);
  assert.strictEqual(cleared.scheduled_at, null);
});

test('a missing conversation returns undefined rather than throwing', () => {
  assert.strictEqual(db.setConversationDisposition(999999, 'no'), undefined);
});

test('rescheduling clears the fired reminder state', () => {
  const id = newConversation('Rescheduled');
  const first = utcStamp(60 * 24);
  db.setConversationDisposition(id, 'appointment', first);

  raw.prepare("INSERT INTO reminder_state (conversation_id, scheduled_at, tier) VALUES (?, ?, 'due_soon')")
    .run(id, first);
  assert.strictEqual(
    raw.prepare('SELECT COUNT(*) c FROM reminder_state WHERE conversation_id = ?').get(id).c, 1);

  db.setConversationDisposition(id, 'appointment', utcStamp(60 * 48));
  assert.strictEqual(
    raw.prepare('SELECT COUNT(*) c FROM reminder_state WHERE conversation_id = ?').get(id).c, 0,
    'a rescheduled appointment must be able to remind again');
});

test('notes are stored and editable', () => {
  const id = newConversation('Noted');
  db.setConversationDisposition(id, 'follow_up', utcStamp(60 * 24), 'wants quarterly pricing');
  assert.strictEqual(
    raw.prepare('SELECT disposition_note FROM conversations WHERE id = ?').get(id).disposition_note,
    'wants quarterly pricing');

  db.setConversationDisposition(id, 'follow_up', utcStamp(60 * 24), 'changed: wants annual');
  assert.strictEqual(
    raw.prepare('SELECT disposition_note FROM conversations WHERE id = ?').get(id).disposition_note,
    'changed: wants annual');
});

test('scheduled times are stored as UTC', () => {
  const id = newConversation('Timezone');
  const utc = '2026-12-25 15:30:00';
  db.setConversationDisposition(id, 'appointment', utc);
  const stored = raw.prepare('SELECT scheduled_at FROM conversations WHERE id = ?').get(id).scheduled_at;
  assert.strictEqual(stored, utc, 'stored verbatim as the UTC string the API normalised');
});
