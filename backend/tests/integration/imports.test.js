'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/testdb');

const ctx = freshDb('imports');
const { db, raw } = ctx;
test.after(() => ctx.cleanup());

test('a clean import counts every contact as new', () => {
  const result = db.bulkImportLeads([
    { phone_number: '+15553330001', name: 'A' },
    { phone_number: '+15553330002', name: 'B' },
    { phone_number: '+15553330003', name: 'C' }
  ], 'Hi [Name]!', '8653456051');

  assert.strictEqual(result.total_submitted, 3);
  assert.strictEqual(result.new_contacts, 3);
  assert.strictEqual(result.existing_contacts, 0);
  assert.strictEqual(result.contacts_updated, 3);
  assert.strictEqual(result.messages_queued, 3);
  assert.strictEqual(result.skipped_suppressed, 0);
  assert.strictEqual(result.invalid_rows, 0);
  assert.strictEqual(result.duplicate_rows, 0);
});

test('re-importing the same numbers counts them as existing, not new', () => {
  const result = db.bulkImportLeads([
    { phone_number: '+15553330001', name: 'A' },
    { phone_number: '+15553330002', name: 'B' }
  ], 'Second pass', '8653456051');

  assert.strictEqual(result.new_contacts, 0, 'already known');
  assert.strictEqual(result.existing_contacts, 2);
  assert.strictEqual(result.messages_queued, 2);
});

test('duplicate rows inside one upload are counted once', () => {
  const result = db.bulkImportLeads([
    { phone_number: '+15553330010', name: 'Dupe' },
    { phone_number: '+15553330010', name: 'Dupe again' },
    { phone_number: '(555) 333-0010', name: 'Same number, different format' }
  ], 'Hi', '8653456051');

  assert.strictEqual(result.total_submitted, 3);
  assert.strictEqual(result.duplicate_rows, 2, 'normalised duplicates are detected');
  assert.strictEqual(result.new_contacts, 1);
  assert.strictEqual(result.messages_queued, 1);
});

test('invalid phone numbers are counted, not imported', () => {
  const result = db.bulkImportLeads([
    { phone_number: '123', name: 'Too short' },
    { phone_number: '', name: 'Empty' },
    { phone_number: 'not-a-phone', name: 'Junk' },
    { phone_number: '+15553330020', name: 'Good' }
  ], 'Hi', '8653456051');

  assert.strictEqual(result.total_submitted, 4);
  assert.strictEqual(result.invalid_rows, 3);
  assert.strictEqual(result.new_contacts, 1);
  assert.strictEqual(result.messages_queued, 1);
});

test('a suppressed contact is NOT reported as imported', () => {
  // Establish the contact, then opt them out.
  db.bulkImportLeads([{ phone_number: '+15553330030', name: 'Gone' }], null, '8653456051');
  const id = raw.prepare('SELECT id FROM conversations WHERE phone_number = ?').get('+15553330030').id;
  db.recordOptOut(id, { source: 'manual', text: 'STOP', actor: 'test' });

  const result = db.bulkImportLeads([
    { phone_number: '+15553330030', name: 'Gone' },
    { phone_number: '+15553330031', name: 'Fresh' }
  ], 'Hi [Name]', '8653456051');

  assert.strictEqual(result.total_submitted, 2);
  assert.strictEqual(result.existing_contacts, 1, 'the suppressed contact already existed');
  assert.strictEqual(result.new_contacts, 1);
  assert.strictEqual(result.contacts_updated, 1, 'ONLY the contactable one was updated');
  assert.strictEqual(result.skipped_suppressed, 1);
  assert.strictEqual(result.skipped_opted_out, 1);
  assert.strictEqual(result.messages_queued, 1, 'no message for the suppressed contact');
});

test('skip reasons are broken out by category', () => {
  const make = (phone, mutate) => {
    db.bulkImportLeads([{ phone_number: phone, name: 'x' }], null, '8653456051');
    const id = raw.prepare('SELECT id FROM conversations WHERE phone_number = ?').get(phone).id;
    mutate(id);
    return id;
  };
  make('+15553330040', id => db.recordOptOut(id, { source: 'manual', actor: 't' }));
  make('+15553330041', id => db.recordWrongNumber(id, { source: 'manual', actor: 't' }));
  make('+15553330042', id => db.setConversationDisposition(id, 'unqualified'));

  const result = db.bulkImportLeads([
    { phone_number: '+15553330040' },
    { phone_number: '+15553330041' },
    { phone_number: '+15553330042' }
  ], 'Hi', '8653456051');

  assert.strictEqual(result.skipped_suppressed, 3);
  assert.strictEqual(result.skipped_opted_out, 1);
  assert.strictEqual(result.skipped_wrong_number, 1);
  assert.strictEqual(result.skipped_disposition, 1);
  assert.strictEqual(result.messages_queued, 0);
});

test('the structured skipped list names each blocked contact', () => {
  const result = db.bulkImportLeads([{ phone_number: '+15553330040' }], 'Hi', '8653456051');
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.skipped[0].reason, 'opted_out');
  assert.ok(result.skipped[0].phone_number);
});

test('an import without a template creates contacts but queues nothing', () => {
  const result = db.bulkImportLeads([{ phone_number: '+15553330050', name: 'Quiet' }], null, '8653456051');
  assert.strictEqual(result.new_contacts, 1);
  assert.strictEqual(result.contacts_updated, 1);
  assert.strictEqual(result.messages_queued, 0);
});

test('bulk send reports the same structured skip data', () => {
  const optedOut = raw.prepare('SELECT id FROM conversations WHERE phone_number = ?').get('+15553330040').id;
  const fine = raw.prepare('SELECT id FROM conversations WHERE phone_number = ?').get('+15553330050').id;

  const result = db.sendBulkMessages([optedOut, fine], 'Hello', '8653456051');
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.skipped[0].id, optedOut);
});
