'use strict';

/**
 * Migrations must be safe to run repeatedly, and safe to run against a
 * database created by an OLDER version of the app that predates the new
 * columns — which is exactly what production is.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function tempFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sms-mig-${label}-`));
  return { dir, file: path.join(dir, 'test.sqlite') };
}

function loadDbModule(file) {
  process.env.SMS_DB_PATH = file;
  delete require.cache[require.resolve('../../database.js')];
  delete require.cache[require.resolve('../../public/lib/classification.js')];
  return require('../../database.js');
}

function columnsOf(rawDb, table) {
  return rawDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

const NEW_CONVERSATION_COLUMNS = [
  'disposition', 'disposition_at', 'scheduled_at', 'disposition_note',
  'reply_classification', 'opted_out', 'opted_out_at', 'opt_out_source',
  'opt_out_text', 'opted_in_at', 'opted_in_by', 'wrong_number',
  'wrong_number_at', 'suppression_reason', 'zip', 'assigned_did'
];

test('migrations create a complete schema on a fresh database', () => {
  const { dir, file } = tempFile('fresh');
  try {
    const db = loadDbModule(file);
    db.initDatabase();

    const cols = columnsOf(db.db, 'conversations');
    NEW_CONVERSATION_COLUMNS.forEach(c =>
      assert.ok(cols.includes(c), `conversations.${c} must exist`));

    const msgCols = columnsOf(db.db, 'messages');
    ['delivered_at', 'carrier_status'].forEach(c =>
      assert.ok(msgCols.includes(c), `messages.${c} must exist`));

    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    ['conversations', 'messages', 'settings', 'users', 'sessions',
     'suppression_events', 'reminder_state'].forEach(t =>
      assert.ok(tables.includes(t), `table ${t} must exist`));

    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations upgrade a legacy database that predates the new columns', () => {
  const { dir, file } = tempFile('legacy');
  try {
    // Build the ORIGINAL schema by hand — no disposition, no suppression.
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        last_message_text TEXT,
        last_message_at TEXT,
        stage TEXT DEFAULT 'Stage 1',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        direction TEXT CHECK(direction IN ('inbound','outbound')) NOT NULL,
        from_number TEXT NOT NULL,
        to_number TEXT NOT NULL,
        body TEXT,
        media_urls TEXT,
        status TEXT CHECK(status IN ('queued','sending','sent','failed','received')) NOT NULL,
        ref_id TEXT, error_message TEXT, scheduled_at TEXT, sent_at TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE settings (key TEXT UNIQUE PRIMARY KEY, value TEXT);
    `);
    legacy.prepare("INSERT INTO conversations (phone_number, name, stage) VALUES (?,?,?)")
      .run('+15559990001', 'Legacy Lead', 'Stage 2');
    legacy.prepare(`INSERT INTO messages (conversation_id, direction, from_number, to_number, body, status)
                    VALUES (1,'inbound','a','b','STOP','received')`).run();
    legacy.close();

    const db = loadDbModule(file);
    db.initDatabase();

    const cols = columnsOf(db.db, 'conversations');
    NEW_CONVERSATION_COLUMNS.forEach(c =>
      assert.ok(cols.includes(c), `conversations.${c} must be added to a legacy db`));

    // Existing data survives untouched.
    const conv = db.db.prepare('SELECT * FROM conversations WHERE phone_number = ?').get('+15559990001');
    assert.strictEqual(conv.name, 'Legacy Lead');
    assert.strictEqual(conv.stage, 'Stage 2', 'existing stage preserved');
    assert.strictEqual(conv.opted_out, 0, 'new flag defaults to 0, not null');

    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('running migrations repeatedly is safe and changes nothing', () => {
  const { dir, file } = tempFile('repeat');
  try {
    const db = loadDbModule(file);
    db.initDatabase();
    db.getOrCreateConversation('+15559990002', 'Repeat');
    db.setConversationDisposition(
      db.db.prepare('SELECT id FROM conversations WHERE phone_number = ?').get('+15559990002').id,
      'no'
    );

    const before = {
      columns: columnsOf(db.db, 'conversations'),
      conversations: db.db.prepare('SELECT * FROM conversations').all()
    };

    // Three more runs, as would happen on three server restarts.
    db.initDatabase();
    db.initDatabase();
    db.initDatabase();

    const after = {
      columns: columnsOf(db.db, 'conversations'),
      conversations: db.db.prepare('SELECT * FROM conversations').all()
    };

    assert.deepStrictEqual(after.columns, before.columns, 'no duplicate columns');
    assert.deepStrictEqual(after.conversations, before.conversations, 'existing data untouched');
    assert.strictEqual(after.conversations[0].disposition, 'no', 'disposition preserved');

    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill finds historical opt-outs anywhere in the message history', () => {
  const { dir, file } = tempFile('backfill');
  try {
    const db = loadDbModule(file);
    db.initDatabase();
    const raw = db.db;

    const mk = (phone, bodies) => {
      const id = raw.prepare('INSERT INTO conversations (phone_number) VALUES (?)').run(phone).lastInsertRowid;
      bodies.forEach((body, i) => {
        raw.prepare(`INSERT INTO messages (conversation_id, direction, from_number, to_number, body, status, created_at)
                     VALUES (?, 'inbound','a','b',?, 'received', ?)`)
          .run(id, body, `2026-01-0${i + 1} 10:00:00`);
      });
      return id;
    };

    // The critical case: STOP first, chatter afterwards. Inferring from the
    // latest reply would have missed this entirely.
    const buried = mk('+15559991001', ['STOP', 'hey are you there?', 'hello?']);
    const plain = mk('+15559991002', ['No thanks']);
    const wrong = mk('+15559991003', ['wrong number']);
    const happy = mk('+15559991004', ['Yes please call me']);

    const summary = db.backfillSuppression();

    assert.strictEqual(summary.conversations_scanned, 4);
    assert.strictEqual(summary.inbound_messages_scanned, 6);
    assert.strictEqual(summary.opt_outs_identified, 1);
    assert.strictEqual(summary.wrong_numbers_identified, 1);
    assert.strictEqual(summary.records_updated, 2);
    assert.strictEqual(summary.ambiguous_left_for_review, 1, 'the plain "No" is left for a human');

    const buriedRow = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(buried);
    assert.strictEqual(buriedRow.opted_out, 1, 'a buried STOP is found');
    assert.strictEqual(buriedRow.opt_out_text, 'STOP');
    assert.strictEqual(buriedRow.opted_out_at, '2026-01-01 10:00:00', 'earliest qualifying message wins');
    assert.strictEqual(buriedRow.opt_out_source, 'backfill');

    assert.strictEqual(raw.prepare('SELECT opted_out FROM conversations WHERE id = ?').get(plain).opted_out, 0,
      'a plain "No" is NOT a legal opt-out');
    assert.strictEqual(raw.prepare('SELECT wrong_number FROM conversations WHERE id = ?').get(wrong).wrong_number, 1);
    assert.strictEqual(raw.prepare('SELECT opted_out FROM conversations WHERE id = ?').get(happy).opted_out, 0);

    // Idempotent: a second run updates nothing further.
    const second = db.backfillSuppression();
    assert.strictEqual(second.records_updated, 0, 'second run is a no-op');
    assert.strictEqual(second.already_suppressed, 1);
    const after = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(buried);
    assert.strictEqual(after.opted_out_at, buriedRow.opted_out_at, 'timestamp not rewritten');

    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill respects a deliberate re-opt-in', () => {
  const { dir, file } = tempFile('optin');
  try {
    const db = loadDbModule(file);
    db.initDatabase();
    const raw = db.db;

    const id = raw.prepare('INSERT INTO conversations (phone_number) VALUES (?)').run('+15559992001').lastInsertRowid;
    raw.prepare(`INSERT INTO messages (conversation_id, direction, from_number, to_number, body, status, created_at)
                 VALUES (?, 'inbound','a','b','STOP','received','2026-01-01 10:00:00')`).run(id);
    // Someone deliberately opted them back in afterwards.
    raw.prepare(`UPDATE conversations SET opted_out = 0, opted_in_at = '2026-02-01 10:00:00',
                 opted_in_by = 'jimbo' WHERE id = ?`).run(id);

    const summary = db.backfillSuppression();
    assert.strictEqual(summary.skipped_due_to_opt_in, 1);
    assert.strictEqual(raw.prepare('SELECT opted_out FROM conversations WHERE id = ?').get(id).opted_out, 0,
      'the backfill must not undo a deliberate re-opt-in');

    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry-run backfill reports without writing', () => {
  const { dir, file } = tempFile('dryrun');
  try {
    const db = loadDbModule(file);
    db.initDatabase();
    const raw = db.db;

    const id = raw.prepare('INSERT INTO conversations (phone_number) VALUES (?)').run('+15559993001').lastInsertRowid;
    raw.prepare(`INSERT INTO messages (conversation_id, direction, from_number, to_number, body, status, created_at)
                 VALUES (?, 'inbound','a','b','unsubscribe','received','2026-01-01 10:00:00')`).run(id);

    const summary = db.backfillSuppression({ dryRun: true });
    assert.strictEqual(summary.dry_run, true);
    assert.strictEqual(summary.opt_outs_identified, 1);
    assert.strictEqual(raw.prepare('SELECT opted_out FROM conversations WHERE id = ?').get(id).opted_out, 0,
      'dry run must not write');

    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
