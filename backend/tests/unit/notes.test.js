'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { freshDb, seedConversation } = require('../helpers/testdb');

test('notes CRUD and targeting by conversation or phone number', () => {
  const { db, raw, cleanup } = freshDb('notes');
  try {
    const convId = seedConversation(raw, { phone: '+12015550199', name: 'Test Prospect' });

    // Test adding note for target with valid conversation ID
    const note1 = db.addNoteForTarget({
      conversationId: convId,
      phoneNumber: '+12015550199',
      noteText: 'Prospect requested pricing sheet'
    });

    assert.ok(note1.id, 'note id should be generated');
    assert.strictEqual(note1.note_text, 'Prospect requested pricing sheet');
    assert.strictEqual(note1.phone_number, '+12015550199');
    assert.ok(note1.created_at, 'timestamp created_at should exist');

    // Query notes by conversation ID
    const notesByConv = db.getNotesForTarget({ conversationId: convId, phoneNumber: '+12015550199' });
    assert.strictEqual(notesByConv.length, 1);
    assert.strictEqual(notesByConv[0].id, note1.id);

    // Query notes by phone number only
    const notesByPhone = db.getNotesForTarget({ conversationId: 0, phoneNumber: '+12015550199' });
    assert.strictEqual(notesByPhone.length, 1);
    assert.strictEqual(notesByPhone[0].id, note1.id);

    // Delete note
    const deleteRes = db.deleteNote(note1.id);
    assert.strictEqual(deleteRes.changes, 1);

    const notesAfterDelete = db.getNotesForTarget({ conversationId: convId, phoneNumber: '+12015550199' });
    assert.strictEqual(notesAfterDelete.length, 0);
  } finally {
    cleanup();
  }
});
