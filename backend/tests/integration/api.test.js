'use strict';

/**
 * Exercises the REAL server over HTTP: auth, validation, suppression
 * enforcement at the API boundary, and the webhook.
 */

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/testserver');

let srv;

test.before(async () => {
  srv = await startServer({ label: 'api' });
  const signup = await srv.signup();
  assert.strictEqual(signup.status, 200, 'admin signup should succeed on a fresh db');
});

test.after(async () => { if (srv) await srv.stop(); });

async function makeConversation(phone, name) {
  const res = await srv.post('/api/conversations', { phone_number: phone, name });
  assert.strictEqual(res.status, 201, `create ${phone}: ${res.text}`);
  return res.json.id;
}

async function inbound(phone, body) {
  const res = await srv.post('/webhook/inbound', { From: phone, To: '8653456051', Message: body }, { auth: false });
  assert.strictEqual(res.status, 200);
}

/* ---------------- authentication ---------------- */

test('protected API routes reject unauthenticated requests', async () => {
  srv.clearCookie();
  for (const url of ['/api/conversations', '/api/settings', '/api/queue/status',
                     '/api/stats?from=2026-01-01&to=2026-01-02']) {
    const res = await srv.get(url, { auth: false });
    assert.strictEqual(res.status, 401, `${url} must require auth`);
  }
  await srv.login();
});

test('a second signup is refused once an admin exists', async () => {
  const res = await srv.post('/api/auth/signup', { username: 'intruder', password: 'x' }, { auth: false });
  assert.strictEqual(res.status, 403);
});

test('login with a bad password fails', async () => {
  const res = await srv.post('/api/auth/login', { username: 'tester', password: 'wrong' }, { auth: false });
  assert.strictEqual(res.status, 401);
  await srv.login();
});

/* ---------------- input validation ---------------- */

test('conversation ids must be positive integers', async () => {
  for (const bad of ['abc', '-1', '1.5', 'null', '1;DROP TABLE']) {
    const res = await srv.post(`/api/conversations/${encodeURIComponent(bad)}/disposition`, { disposition: 'no' });
    assert.strictEqual(res.status, 400, `id "${bad}" must be rejected`);
  }
});

test('stats rejects malformed and impossible dates', async () => {
  for (const [from, to] of [['nope', '2026-01-01'], ['2026-13-01', '2026-01-02'],
                            ['2026-02-30', '2026-03-01'], ['2026-01-02', '2026-01-01']]) {
    const res = await srv.get(`/api/stats?from=${from}&to=${to}`);
    assert.strictEqual(res.status, 400, `${from}..${to} must be rejected`);
  }
  const ok = await srv.get('/api/stats?from=2026-01-01&to=2026-01-31');
  assert.strictEqual(ok.status, 200);
});

test('an appointment rejects invalid, impossible and out-of-range dates', async () => {
  const id = await makeConversation('+15556660001', 'Validation');
  const bad = [
    ['', 'empty'],
    ['not-a-date', 'garbage'],
    ['2026-02-30T10:00:00Z', 'impossible day'],
    ['1970-01-01T00:00:00Z', 'before the supported range'],
    ['2199-01-01T00:00:00Z', 'too far ahead']
  ];
  for (const [value, why] of bad) {
    const res = await srv.post(`/api/conversations/${id}/disposition`,
      { disposition: 'appointment', scheduled_at: value });
    assert.strictEqual(res.status, 400, `${why} must be rejected`);
  }
});

test('a past appointment is rejected unless explicitly allowed', async () => {
  const id = await makeConversation('+15556660002', 'Past');
  const past = new Date(Date.now() - 86400000).toISOString();

  const rejected = await srv.post(`/api/conversations/${id}/disposition`,
    { disposition: 'appointment', scheduled_at: past });
  assert.strictEqual(rejected.status, 400);
  assert.match(rejected.json.error, /past/i);

  const allowed = await srv.post(`/api/conversations/${id}/disposition`,
    { disposition: 'appointment', scheduled_at: past, allow_past: true });
  assert.strictEqual(allowed.status, 200, 'explicit backdating is permitted');
});

test('schedules are stored as UTC regardless of the offset sent', async () => {
  const id = await makeConversation('+15556660003', 'Offsets');
  // Same instant, three notations.
  const instants = ['2026-12-25T15:30:00Z', '2026-12-25T10:30:00-05:00', '2026-12-25T16:30:00+01:00'];
  for (const value of instants) {
    const res = await srv.post(`/api/conversations/${id}/disposition`,
      { disposition: 'appointment', scheduled_at: value });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.json.scheduled_at, '2026-12-25 15:30:00',
      `${value} must normalise to the same UTC instant`);
  }
});

test('an invalid disposition value is rejected', async () => {
  const id = await makeConversation('+15556660004', 'BadDispo');
  const res = await srv.post(`/api/conversations/${id}/disposition`, { disposition: 'banana' });
  assert.strictEqual(res.status, 400);
});

test('a disposition on a missing conversation returns 404', async () => {
  const res = await srv.post('/api/conversations/999999/disposition', { disposition: 'no' });
  assert.strictEqual(res.status, 404);
});

test('oversized message bodies are rejected', async () => {
  const id = await makeConversation('+15556660005', 'Long');
  const res = await srv.post(`/api/conversations/${id}/messages`, { body: 'x'.repeat(2000) });
  assert.strictEqual(res.status, 400);
});

/* ---------------- suppression at the API boundary ---------------- */

test('an individual send to an opted-out contact is refused with 409', async () => {
  const phone = '+15556661001';
  const id = await makeConversation(phone, 'OptedOut');
  await inbound(phone, 'STOP');

  const res = await srv.post(`/api/conversations/${id}/messages`, { body: 'are you sure?' });
  assert.strictEqual(res.status, 409, 'must not be silently allowed');
  assert.strictEqual(res.json.blocked, true);
  assert.strictEqual(res.json.reason, 'opted_out');

  const messages = await srv.get(`/api/conversations/${id}/messages`);
  const outbound = messages.json.filter(m => m.direction === 'outbound');
  assert.strictEqual(outbound.length, 0, 'no outbound row may be created');
});

test('an individual send to a wrong number is refused', async () => {
  const phone = '+15556661002';
  const id = await makeConversation(phone, 'Wrong');
  await inbound(phone, 'wrong number');
  const res = await srv.post(`/api/conversations/${id}/messages`, { body: 'hello?' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.reason, 'wrong_number');
});

test('an individual send to a "No" disposition is still allowed', async () => {
  const id = await makeConversation('+15556661003', 'SoftNo');
  await srv.post(`/api/conversations/${id}/disposition`, { disposition: 'no' });
  const res = await srv.post(`/api/conversations/${id}/messages`, { body: 'one more thing' });
  assert.strictEqual(res.status, 201, 'business dispositions do not block a human reply');
});

test('bulk and campaign endpoints report structured skips', async () => {
  const phone = '+15556661010';
  const id = await makeConversation(phone, 'BulkBlocked');
  await inbound(phone, 'unsubscribe');
  const okId = await makeConversation('+15556661011', 'BulkFine');

  const res = await srv.post('/api/conversations/bulk-message', {
    conversation_ids: [id, okId], message_text: 'Hello all'
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.queued_count, 1);
  assert.strictEqual(res.json.skipped_count, 1);
  assert.strictEqual(res.json.skipped_opted_out, 1);
  assert.ok(Array.isArray(res.json.skipped));
});

test('CSV upload returns audited counts, not an inflated imported_count', async () => {
  const phone = '+15556661020';
  const id = await makeConversation(phone, 'ImportBlocked');
  await inbound(phone, 'take me off your list');

  const res = await srv.post('/api/leads/upload', {
    leads: [
      { phone_number: phone, name: 'ImportBlocked' },
      { phone_number: '+15556661021', name: 'Fresh' },
      { phone_number: 'garbage', name: 'Bad' }
    ],
    message_template: 'Hi [Name]'
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.imported_count, undefined, 'the misleading field is gone');
  assert.strictEqual(res.json.total_submitted, 3);
  assert.strictEqual(res.json.new_contacts, 1);
  assert.strictEqual(res.json.existing_contacts, 1);
  assert.strictEqual(res.json.contacts_updated, 1);
  assert.strictEqual(res.json.invalid_rows, 1);
  assert.strictEqual(res.json.messages_queued, 1);
  assert.strictEqual(res.json.skipped_opted_out, 1);
});

/* ---------------- re-opt-in ---------------- */

test('re-opt-in requires explicit confirmation and then permits sending', async () => {
  const phone = '+15556662001';
  const id = await makeConversation(phone, 'Returner');
  await inbound(phone, 'STOP');

  const noConfirm = await srv.post(`/api/conversations/${id}/opt-in`, {});
  assert.strictEqual(noConfirm.status, 400, 'confirmation is mandatory');

  const confirmed = await srv.post(`/api/conversations/${id}/opt-in`, { confirm: true });
  assert.strictEqual(confirmed.status, 200);
  assert.strictEqual(confirmed.json.opted_out, 0);
  assert.strictEqual(confirmed.json.opted_in_by, 'tester', 'the actor is recorded');

  const send = await srv.post(`/api/conversations/${id}/messages`, { body: 'welcome back' });
  assert.strictEqual(send.status, 201);
});

test('a manual opt-out blocks sending immediately', async () => {
  const id = await makeConversation('+15556662002', 'ManualStop');
  const res = await srv.post(`/api/conversations/${id}/opt-out`, { reason: 'asked on the phone' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.opted_out, 1);
  assert.strictEqual(res.json.opt_out_source, 'manual');

  const send = await srv.post(`/api/conversations/${id}/messages`, { body: 'hi' });
  assert.strictEqual(send.status, 409);
});

/* ---------------- webhook ---------------- */

test('the inbound webhook records an opt-out without authentication', async () => {
  const phone = '+15556663001';
  await makeConversation(phone, 'Webhook');
  await inbound(phone, 'STOP');

  const list = await srv.get('/api/conversations');
  const conv = list.json.find(c => c.phone_number === phone);
  assert.strictEqual(conv.opted_out, 1);
  assert.strictEqual(conv.reply_classification, 'opt_out');
});

test('conversations expose suppression state to the browser', async () => {
  const list = await srv.get('/api/conversations');
  const sample = list.json[0];
  ['opted_out', 'wrong_number', 'reply_classification', 'disposition'].forEach(field => {
    assert.ok(field in sample, `${field} must be returned to the UI`);
  });
});

test('provider credentials are not leaked by the conversations endpoint', async () => {
  const list = await srv.get('/api/conversations');
  const serialised = JSON.stringify(list.json);
  assert.ok(!/bulkvs_token|fractel_password/.test(serialised));
});

/* ---------------- backfill endpoint ---------------- */

test('the backfill endpoint runs and reports a summary', async () => {
  const res = await srv.post('/api/admin/backfill-suppression', { dry_run: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.dry_run, true);
  assert.ok(typeof res.json.conversations_scanned === 'number');
});

test('no unexpected server errors were logged during the suite', () => {
  const unexpected = srv.serverErrors.join('');
  assert.strictEqual(unexpected.trim(), '', `server logged errors:\n${unexpected}`);
});
