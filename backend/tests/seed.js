/**
 * Seeds a database with realistic conversations covering every folder,
 * for E2E tests and manual inspection.
 *
 * Usage:  SMS_DB_PATH=/tmp/e2e.sqlite node tests/seed.js
 *
 * Refuses to run against the production database file.
 */
'use strict';

const path = require('path');

if (!process.env.SMS_DB_PATH) {
  console.error('Refusing to seed: set SMS_DB_PATH to a throwaway database first.');
  process.exit(1);
}
if (path.resolve(process.env.SMS_DB_PATH) === path.resolve(__dirname, '..', 'database.sqlite')) {
  console.error('Refusing to seed the production database.');
  process.exit(1);
}

const db = require('../database');
db.initDatabase();
const raw = db.db;

// Deterministic timestamps relative to now so "overdue" and "due soon" are stable.
const iso = offsetMinutes =>
  new Date(Date.now() + offsetMinutes * 60000).toISOString().slice(0, 19).replace('T', ' ');

function conversation(phone, name, { stage = 'Stage 1', city = 'Orlando' } = {}) {
  const conv = db.getOrCreateConversation(phone, name, city);
  raw.prepare('UPDATE conversations SET stage = ? WHERE id = ?').run(stage, conv.id);
  return conv.id;
}

function outbound(id, body, { status = 'sent', minutesAgo = 120, delivered = false } = {}) {
  const created = iso(-minutesAgo);
  const msgId = raw.prepare(`
    INSERT INTO messages (conversation_id, direction, from_number, to_number, body, status, created_at)
    VALUES (?, 'outbound', '8653456051', (SELECT phone_number FROM conversations WHERE id = ?), ?, ?, ?)
  `).run(id, id, body, status, created).lastInsertRowid;
  if (delivered) {
    raw.prepare("UPDATE messages SET delivered_at = ?, carrier_status = 'DELIVRD' WHERE id = ?")
      .run(iso(-minutesAgo + 1), msgId);
  }
  raw.prepare('UPDATE conversations SET last_message_text = ?, last_message_at = ? WHERE id = ?')
    .run(body, created, id);
  return msgId;
}

// Routed through insertMessage so classification and suppression fire for real.
function inbound(id, body, minutesAgo = 60) {
  const conv = raw.prepare('SELECT phone_number FROM conversations WHERE id = ?').get(id);
  const inserted = db.insertMessage({
    conversation_id: id, direction: 'inbound',
    from_number: conv.phone_number, to_number: '8653456051',
    body, status: 'received'
  });
  raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(iso(-minutesAgo), inserted.id);
  return inserted.id;
}

const OPENER = 'Hi, this is Braden from StormTarget. We noticed storm activity near your property — want a free inspection?';

// ---- New: positive replies awaiting disposition -------------------------
const maria = conversation('+14075550101', 'Maria Chen');
outbound(maria, OPENER, { delivered: true });
inbound(maria, 'Yes! What time works for you?', 30);

const priya = conversation('+12015550102', 'Priya Raman');
outbound(priya, OPENER, { delivered: true });
inbound(priya, 'how much does it cost?', 45);

const grace = conversation('+12145550103', 'Grace Lin');
outbound(grace, OPENER);
inbound(grace, '?', 20);

// ---- Hot Leads: appointments (one overdue, one due soon, one future) ----
const kenji = conversation('+13125550110', 'Kenji Watanabe');
outbound(kenji, OPENER, { delivered: true });
inbound(kenji, 'Sounds good, book me in', 300);
db.setConversationDisposition(kenji, 'appointment', iso(-180), 'overdue on purpose');

const dana = conversation('+14155550111', 'Dana Whitfield');
outbound(dana, OPENER, { delivered: true });
inbound(dana, 'Tomorrow works', 200);
db.setConversationDisposition(dana, 'appointment', iso(12), 'due within the hour');

const marcus = conversation('+17025550112', 'Marcus Bell');
outbound(marcus, OPENER, { delivered: true });
inbound(marcus, 'Send me the details', 400);
db.setConversationDisposition(marcus, 'appointment', iso(60 * 26), 'tomorrow');

// ---- Hot Leads: follow-ups ---------------------------------------------
const nia = conversation('+13055550120', 'Nia Adeyemi');
outbound(nia, OPENER, { delivered: true });
inbound(nia, 'Maybe next month, call me in June', 500);
db.setConversationDisposition(nia, 'follow_up', iso(60 * 72), 'call back in June');

// ---- Customers ---------------------------------------------------------
const carlos = conversation('+12025550130', 'Carlos Mendez');
outbound(carlos, OPENER, { delivered: true });
inbound(carlos, 'We signed up, thanks!', 600);
db.setConversationDisposition(carlos, 'customer');

// ---- Closed > No (business rejection, NOT an opt-out) ------------------
const tom = conversation('+14045550140', 'Tom Beckett');
outbound(tom, OPENER, { delivered: true });
inbound(tom, 'No thanks', 700);

const sandra = conversation('+12065550141', 'Sandra Willis');
outbound(sandra, OPENER);
inbound(sandra, 'not interested', 800);

// ---- Closed > Unqualified ---------------------------------------------
const ed = conversation('+13035550150', 'Ed Novak');
outbound(ed, OPENER, { delivered: true });
inbound(ed, 'I rent, I do not own the place', 900);
db.setConversationDisposition(ed, 'unqualified', null, 'renter');

// ---- Closed > Opted Out (legal suppression) ----------------------------
const dwayne = conversation('+16175550160', 'Dwayne Ortiz');
outbound(dwayne, OPENER, { delivered: true });
inbound(dwayne, 'STOP', 1000);

// The critical regression case: STOP, then chatter afterwards.
const alicia = conversation('+16155550161', 'Alicia Gordon');
outbound(alicia, OPENER, { delivered: true });
inbound(alicia, 'Please remove me from your list', 1100);
inbound(alicia, 'actually what were you offering?', 500);

// ---- Closed > Wrong Number --------------------------------------------
const stranger = conversation('+15035550170', 'Unknown');
outbound(stranger, OPENER);
inbound(stranger, 'wrong number', 1200);

// ---- Pending: contacted, no reply --------------------------------------
const pendingAreaCodes = ['+13125550180', '+14075550181', '+12145550182'];
['Bill Hargrove', 'Renee Fontaine', 'Omar Haddad'].forEach((name, i) => {
  const id = conversation(pendingAreaCodes[i], name, { stage: `Stage ${i + 1}` });
  outbound(id, OPENER, { status: i === 2 ? 'queued' : 'sent', delivered: i === 0, minutesAgo: 300 + i * 60 });
});

// A failed send, so the stats have a non-zero failure figure.
const failed = conversation('+13055550190', 'Bounced Number');
outbound(failed, OPENER, { status: 'failed', minutesAgo: 240 });

const summary = {
  conversations: raw.prepare('SELECT COUNT(*) c FROM conversations').get().c,
  messages: raw.prepare('SELECT COUNT(*) c FROM messages').get().c,
  opted_out: raw.prepare('SELECT COUNT(*) c FROM conversations WHERE opted_out = 1').get().c,
  wrong_number: raw.prepare('SELECT COUNT(*) c FROM conversations WHERE wrong_number = 1').get().c
};
console.log('Seeded:', JSON.stringify(summary));
