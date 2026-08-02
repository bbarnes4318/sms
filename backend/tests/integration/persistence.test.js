'use strict';

/**
 * Suppression, dispositions and reminder state must survive a server restart
 * and must not be undone by later inbound traffic.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.resolve(__dirname, '..', '..', 'server.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-restart-'));
const DB = path.join(dir, 'restart.sqlite');
const PORT = 4690;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let cookie = '';

async function boot() {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SMS_DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => logs.push(d.toString()));

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/auth/status`);
      if (res.ok) return logs;
    } catch (_) { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server did not boot:\n${logs.join('')}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

async function shutdown() {
  if (!child) return;
  child.kill();
  await new Promise(r => { child.on('exit', r); setTimeout(r, 3000); });
  child = null;
}

async function req(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${url}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: res.status, json, text };
}

test.after(async () => {
  await shutdown();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

test('state survives a full server restart', async () => {
  await boot();
  await req('POST', '/api/auth/signup', { username: 'restart', password: 'restart-pass-123' });

  // Build state: an opt-out, an appointment and a delivered reminder.
  const optOut = (await req('POST', '/api/conversations', { phone_number: '+15557770001', name: 'Gone' })).json;
  await req('POST', '/webhook/inbound', { From: '+15557770001', To: '8653456051', Message: 'STOP' });

  const booked = (await req('POST', '/api/conversations', { phone_number: '+15557770002', name: 'Booked' })).json;
  const when = new Date(Date.now() + 3600000).toISOString();
  const dispo = await req('POST', `/api/conversations/${booked.id}/disposition`,
    { disposition: 'appointment', scheduled_at: when });
  assert.strictEqual(dispo.status, 200, dispo.text);
  const storedSchedule = dispo.json.scheduled_at;

  await req('POST', '/api/reminders/ack',
    { conversation_id: booked.id, scheduled_at: storedSchedule, tier: 'due_60' });

  // Confirm before the restart.
  let list = (await req('GET', '/api/conversations')).json;
  assert.strictEqual(list.find(c => c.id === optOut.id).opted_out, 1);

  // ---- restart ----
  await shutdown();
  const logs = await boot();
  await req('POST', '/api/auth/login', { username: 'restart', password: 'restart-pass-123' });

  const joined = logs.join('');
  assert.ok(!/Error|error:/i.test(joined.replace(/FracTEL|BulkVS/gi, '')),
    `restart logged errors:\n${joined}`);

  list = (await req('GET', '/api/conversations')).json;
  const after = list.find(c => c.id === optOut.id);
  assert.strictEqual(after.opted_out, 1, 'opt-out survives restart');
  assert.strictEqual(after.opt_out_text, 'STOP', 'audit trail survives restart');

  const bookedAfter = list.find(c => c.id === booked.id);
  assert.strictEqual(bookedAfter.disposition, 'appointment', 'disposition survives restart');
  assert.strictEqual(bookedAfter.scheduled_at, storedSchedule, 'schedule survives restart');

  const reminders = (await req('GET', '/api/reminders')).json;
  assert.ok(reminders.notified.some(r =>
    r.conversation_id === booked.id && r.tier === 'due_60'),
    'reminder state survives restart, so it will not fire twice');

  // A later inbound message must NOT lift the opt-out.
  await req('POST', '/webhook/inbound',
    { From: '+15557770001', To: '8653456051', Message: 'hey are you still there?' });

  list = (await req('GET', '/api/conversations')).json;
  const stillBlocked = list.find(c => c.id === optOut.id);
  assert.strictEqual(stillBlocked.opted_out, 1, 'a later message does not clear the opt-out');
  assert.strictEqual(stillBlocked.reply_classification, 'positive',
    'the display classification tracks the newest reply');

  const send = await req('POST', `/api/conversations/${optOut.id}/messages`, { body: 'hello?' });
  assert.strictEqual(send.status, 409, 'still blocked after restart and a new inbound');
});

test('migrations run cleanly a second time on a populated database', async () => {
  // The restart above already re-ran initDatabase against a database that had
  // real data in it; assert the data is intact and the schema is unchanged.
  const Database = require('better-sqlite3');
  const raw = new Database(DB, { readonly: true });
  const conversations = raw.prepare('SELECT COUNT(*) c FROM conversations').get().c;
  const columns = raw.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
  raw.close();

  assert.ok(conversations >= 2, 'data preserved across the restart');
  const duplicates = columns.filter((c, i) => columns.indexOf(c) !== i);
  assert.deepStrictEqual(duplicates, [], 'migrations did not duplicate any column');
});
