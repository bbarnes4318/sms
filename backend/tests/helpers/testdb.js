/**
 * Test database helper.
 *
 * Every test file gets its own throwaway SQLite file under the OS temp
 * directory. SMS_DB_PATH must be set BEFORE database.js is required, because
 * the module opens its connection at import time.
 *
 * Nothing here ever touches backend/database.sqlite.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function freshDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sms-test-${label}-`));
  const file = path.join(dir, 'test.sqlite');

  process.env.SMS_DB_PATH = file;
  // Drop any cached copy so each helper call gets a module bound to this file.
  delete require.cache[require.resolve('../../database.js')];
  delete require.cache[require.resolve('../../public/lib/classification.js')];

  const db = require('../../database.js');
  db.initDatabase();

  return {
    db,
    raw: db.db,
    file,
    cleanup() {
      try { db.db.close(); } catch (_) { /* already closed */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  };
}

/** Insert a conversation directly, bypassing the app's own code paths. */
function seedConversation(raw, { phone, name = null, stage = 'Stage 1', createdAt = null, ...rest }) {
  const columns = ['phone_number', 'name', 'stage'];
  const values = [phone, name, stage];
  if (createdAt) { columns.push('created_at'); values.push(createdAt); }
  Object.entries(rest).forEach(([k, v]) => { columns.push(k); values.push(v); });

  const placeholders = columns.map(() => '?').join(', ');
  const result = raw.prepare(
    `INSERT INTO conversations (${columns.join(', ')}) VALUES (${placeholders})`
  ).run(...values);
  return result.lastInsertRowid;
}

/** Insert a message directly, so tests can build history without side effects. */
function seedMessage(raw, { conversationId, direction, body = '', status = null, createdAt = null, deliveredAt = null }) {
  const finalStatus = status || (direction === 'inbound' ? 'received' : 'sent');
  const columns = ['conversation_id', 'direction', 'from_number', 'to_number', 'body', 'status'];
  const values = [conversationId, direction, 'from', 'to', body, finalStatus];
  if (createdAt) { columns.push('created_at'); values.push(createdAt); }
  if (deliveredAt) { columns.push('delivered_at'); values.push(deliveredAt); }

  const placeholders = columns.map(() => '?').join(', ');
  return raw.prepare(
    `INSERT INTO messages (${columns.join(', ')}) VALUES (${placeholders})`
  ).run(...values).lastInsertRowid;
}

/** UTC 'YYYY-MM-DD HH:MM:SS', matching what the app stores. */
function utcStamp(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { freshDb, seedConversation, seedMessage, utcStamp };
