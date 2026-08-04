const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const dotenv = require('dotenv');
const db = require('./database');
const queueWorker = require('./queue');

// Load environment variables from backend/.env if present
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Initialize database
db.initDatabase();

// Start SMS queue worker
queueWorker.start();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Helper to parse cookies
// Session cookies get Secure when the request arrived over HTTPS (behind
// nginx that shows up as x-forwarded-proto).
function sessionCookie(req, token, maxAgeSeconds) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim();
  const secure = proto === 'https' ? ' Secure;' : '';
  return `session_token=${token}; Path=/; HttpOnly;${secure} Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

function getCookie(cookieString, name) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

/* ------------------------------------------------------------------
 * Request validation helpers
 *
 * TIME MODEL: every timestamp this application stores is UTC.
 * SQLite datetime('now') is UTC. The browser sends scheduled times as a
 * full ISO-8601 instant, which is converted to UTC here. The browser is
 * the only place local time is rendered.
 * ------------------------------------------------------------------ */

// CSV imports post the whole parsed batch as JSON; the express default of
// 100 kb silently rejected large lists.
const JSON_BODY_LIMIT = '4mb';
const MAX_MESSAGE_LENGTH = 1600;   // 10 SMS segments
const MAX_LEADS_PER_UPLOAD = 20000;
const MAX_BULK_RECIPIENTS = 20000;

// Schedules must land inside a sane window; guards against typos like year 202.
const MIN_SCHEDULE_MS = Date.UTC(2000, 0, 1);
const MAX_SCHEDULE_AHEAD_MS = 5 * 365 * 24 * 60 * 60 * 1000;

function parseConversationId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Validate a client-supplied schedule instant and normalise it to a UTC
 * 'YYYY-MM-DD HH:MM:SS' string for storage.
 */
function validateScheduleInput(value, { allowPast = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'A date and time is required' };
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return { ok: false, error: 'Invalid date and time' };
  }
  const ms = date.getTime();
  if (ms < MIN_SCHEDULE_MS) {
    return { ok: false, error: 'Date is before the earliest supported date (2000-01-01)' };
  }
  if (ms > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
    return { ok: false, error: 'Date is more than 5 years in the future' };
  }
  if (!allowPast && ms < Date.now() - 60000) {
    return { ok: false, error: 'Date and time is in the past' };
  }
  return { ok: true, utc: date.toISOString().slice(0, 19).replace('T', ' ') };
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Middleware
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Never leak internals to the browser; log the detail server-side instead.
function fail(res, status, publicMessage, err) {
  if (err) console.error(`[error] ${publicMessage}:`, err.message);
  return res.status(status).json({ error: publicMessage });
}

// Auth status (public check)
app.get('/api/auth/status', (req, res) => {
  try {
    const userCount = db.countUsers();
    res.json({ has_admin: userCount > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin signup (first time setup)
app.post('/api/auth/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const userCount = db.countUsers();
    if (userCount > 0) {
      return res.status(403).json({ error: 'Administrator already configured' });
    }
    db.createUser(username, password);
    const session = db.createSession(username);
    res.setHeader('Set-Cookie', sessionCookie(req, session.token, 7 * 24 * 60 * 60));
    res.json({ success: true, username: session.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Login rate limiting: a small in-memory sliding window per client IP.
 * Enough to stop credential stuffing against a single-admin deployment
 * without adding a dependency or shared store.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket.remoteAddress || 'unknown';
}

function loginRateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, recent);

  // Keep the map from growing without bound on a long-lived process.
  if (loginAttempts.size > 5000) {
    for (const [key, times] of loginAttempts) {
      if (!times.length || now - times[times.length - 1] > LOGIN_WINDOW_MS) loginAttempts.delete(key);
    }
  }
  return recent.length >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(req) {
  const ip = clientIp(req);
  const times = loginAttempts.get(ip) || [];
  times.push(Date.now());
  loginAttempts.set(ip, times);
}

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (loginRateLimited(req)) {
    console.warn(`[auth] rate limited login attempts from ${clientIp(req)}`);
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  try {
    const user = db.validateUser(username, password);
    if (!user) {
      recordFailedLogin(req);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const session = db.createSession(user.username);
    res.setHeader('Set-Cookie', sessionCookie(req, session.token, 7 * 24 * 60 * 60));
    res.json({ success: true, username: session.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  try {
    const token = getCookie(req.headers.cookie, 'session_token');
    if (token) {
      db.deleteSession(token);
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Render login page
app.get('/login', (req, res) => {
  const token = getCookie(req.headers.cookie, 'session_token');
  const session = token ? db.validateSession(token) : null;
  if (session) {
    return res.redirect('/');
  }
  res.sendFile(path.resolve(__dirname, 'public', 'login.html'));
});

// Exclude public paths from authentication
const PUBLIC_PATHS = [
  '/login',
  '/login.html',
  '/login.css',
  '/login.js',
  '/leadzer.png',
  '/favicon.ico',
  '/api/auth/status',
  '/api/auth/signup',
  '/api/auth/login'
];

app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path) || req.path.startsWith('/webhook/')) {
    return next();
  }

  const token = getCookie(req.headers.cookie, 'session_token');
  const session = token ? db.validateSession(token) : null;
  if (!session) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }

  req.user = session;
  next();
});

// Serve main static assets with strict no-cache headers
app.use(express.static(path.resolve(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Store WebSocket clients
const clients = new Set();

wss.on('connection', (ws, req) => {
  const token = getCookie(req.headers.cookie, 'session_token');
  const session = token ? db.validateSession(token) : null;
  if (!session) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  clients.add(ws);
  console.log('Client connected. Total clients:', clients.size);
  
  // Send current queue status upon connection
  ws.send(JSON.stringify({
    type: 'queue_status',
    data: db.getQueueStats()
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected. Total clients:', clients.size);
  });
});

// Broadcast to all WebSocket clients
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Listen for message status changes in the queue worker
queueWorker.on('messageStatusChanged', (msgEvent) => {
  broadcast('message_status', msgEvent);
  broadcast('queue_status', db.getQueueStats());
});

// REST API Endpoints

// 1. Get all conversations
app.get('/api/conversations', (req, res) => {
  try {
    const list = db.getConversations();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Create new conversation
app.post('/api/conversations', (req, res) => {
  const { phone_number, name, city, zip } = req.body;
  if (!phone_number) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const conv = db.getOrCreateConversation(phone_number, name, city || null, zip || null);
    res.status(201).json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2.5. Delete conversation
app.delete('/api/conversations/:id', (req, res) => {
  const convId = parseInt(req.params.id, 10);
  try {
    db.deleteConversation(convId);
    // Broadcast updates
    broadcast('conversation_deleted', { id: convId });
    broadcast('queue_status', db.getQueueStats());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get messages for a conversation (and mark conversation read)
app.get('/api/conversations/:id/messages', (req, res) => {
  const convId = parseInt(req.params.id, 10);
  try {
    db.markConversationRead(convId);
    broadcast('conversation_read', { id: convId });
    const messages = db.getMessages(convId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.5. Mark conversation read explicitly
app.post('/api/conversations/:id/read', (req, res) => {
  const convId = parseInt(req.params.id, 10);
  try {
    db.markConversationRead(convId);
    broadcast('conversation_read', { id: convId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.6. Set / clear a lead disposition
app.post('/api/conversations/:id/disposition', (req, res) => {
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }

  const { disposition, scheduled_at, note, allow_past } = req.body;
  const wantsSchedule = disposition === 'appointment' || disposition === 'follow_up';

  if (disposition !== null && disposition !== undefined &&
      !db.VALID_DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ error: `Invalid disposition: ${disposition}` });
  }
  if (typeof note === 'string' && note.length > 1000) {
    return res.status(400).json({ error: 'Note exceeds 1000 characters' });
  }

  let utcSchedule = null;
  if (wantsSchedule) {
    // Past times are allowed only when the client explicitly asks, so that a
    // missed appointment can be logged after the fact without a silent default.
    const validation = validateScheduleInput(scheduled_at, { allowPast: allow_past === true });
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    utcSchedule = validation.utc;
  }

  try {
    const updated = db.setConversationDisposition(
      convId,
      disposition || null,
      utcSchedule,
      note || null,
      req.user && req.user.username
    );
    if (!updated) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    broadcast('conversation_disposition', updated);
    res.json(updated);
  } catch (err) {
    return fail(res, 400, err.message, err);
  }
});

// 3.6b. Explicit re-opt-in. Deliberately separate from disposition changes so
// that clearing a disposition can never resurrect a suppressed contact.
app.post('/api/conversations/:id/opt-in', (req, res) => {
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }
  if (req.body.confirm !== true) {
    return res.status(400).json({
      error: 'Re-opt-in requires explicit confirmation ({"confirm": true})'
    });
  }

  try {
    const actor = (req.user && req.user.username) || 'unknown';
    const updated = db.recordOptIn(convId, actor);
    if (!updated) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    broadcast('conversation_disposition', updated);
    res.json(updated);
  } catch (err) {
    return fail(res, 400, err.message, err);
  }
});

// Notes API
app.get('/api/conversations/:id/notes', (req, res) => {
  const paramId = req.params.id;
  const phoneNumber = req.query.phone_number || null;
  let convId = parseConversationId(paramId);

  try {
    const notes = db.getNotesForTarget({ conversationId: convId, phoneNumber });
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations/:id/notes', (req, res) => {
  const paramId = req.params.id;
  const { note_text, phone_number } = req.body;
  let convId = parseConversationId(paramId);

  if (!note_text || typeof note_text !== 'string' || !note_text.trim()) {
    return res.status(400).json({ error: 'Note text is required' });
  }

  try {
    const newNote = db.addNoteForTarget({
      conversationId: convId,
      phoneNumber: phone_number || null,
      noteText: note_text
    });
    broadcast('note_created', { conversation_id: convId, note: newNote });
    res.json(newNote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:noteId', (req, res) => {
  const noteId = parseInt(req.params.noteId, 10);
  if (isNaN(noteId)) {
    return res.status(400).json({ error: 'Invalid note id' });
  }
  try {
    db.deleteNote(noteId);
    broadcast('note_deleted', { note_id: noteId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.6c. Manually suppress a contact.
app.post('/api/conversations/:id/opt-out', (req, res) => {
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }

  try {
    const actor = (req.user && req.user.username) || 'unknown';
    const kind = req.body.kind === 'wrong_number' ? 'wrong_number' : 'opt_out';
    const updated = kind === 'wrong_number'
      ? db.recordWrongNumber(convId, { source: 'manual', text: req.body.reason || null, actor })
      : db.recordOptOut(convId, { source: 'manual', text: req.body.reason || null, actor });

    if (!updated) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    broadcast('conversation_disposition', updated);
    res.json(updated);
  } catch (err) {
    return fail(res, 400, err.message, err);
  }
});

// 3.6e. Reminder state. Persisted server-side so a reminder fires once per
// tier and survives page refreshes and server restarts.
app.get('/api/reminders', (req, res) => {
  try {
    res.json({ notified: db.getNotifiedReminders() });
  } catch (err) {
    return fail(res, 500, 'Could not load reminder state', err);
  }
});

app.post('/api/reminders/ack', (req, res) => {
  const convId = parseConversationId(req.body.conversation_id);
  const { scheduled_at, tier } = req.body;

  if (convId === null || typeof scheduled_at !== 'string' || typeof tier !== 'string') {
    return res.status(400).json({ error: 'conversation_id, scheduled_at and tier are required' });
  }
  if (!db.REMINDER_TIERS.includes(tier)) {
    return res.status(400).json({ error: `Unknown reminder tier: ${tier}` });
  }

  try {
    db.acknowledgeReminder(convId, scheduled_at, tier);
    res.json({ success: true });
  } catch (err) {
    return fail(res, 500, 'Could not record reminder', err);
  }
});

// 3.6d. Run the historical suppression backfill on demand.
app.post('/api/admin/backfill-suppression', (req, res) => {
  try {
    const summary = db.backfillSuppression({ dryRun: req.body.dry_run === true });
    console.log('[backfill] summary:', JSON.stringify(summary));
    res.json(summary);
  } catch (err) {
    return fail(res, 500, 'Backfill failed', err);
  }
});

// 3.7. Performance stats for a date range
app.get('/api/stats', (req, res) => {
  const { from, to, start, end, tz_offset } = req.query;

  if (!isIsoDate(from) || !isIsoDate(to)) {
    return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from must not be after to' });
  }

  // The browser sends the exact UTC instants bounding its LOCAL day range,
  // plus its offset, so a message sent at 8pm Eastern is counted on the day
  // the user actually sent it rather than rolling into the next UTC day.
  const options = {};
  if (start && end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate >= endDate) {
      return res.status(400).json({ error: 'Invalid start/end instants' });
    }
    options.startUtc = startDate.toISOString().slice(0, 19).replace('T', ' ');
    options.endUtc = endDate.toISOString().slice(0, 19).replace('T', ' ');
  }
  const offset = Number(tz_offset);
  if (Number.isFinite(offset) && Math.abs(offset) <= 900) {
    options.tzOffsetMinutes = offset;
  }

  try {
    res.json(db.getStats(from, to, options));
  } catch (err) {
    return fail(res, 500, 'Could not load stats', err);
  }
});

// 4. Queue a message (Outbound)
app.post('/api/conversations/:id/messages', (req, res) => {
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }
  const { body, media_urls, scheduled_at, from_number } = req.body;

  if (typeof body === 'string' && body.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message body exceeds ${MAX_MESSAGE_LENGTH} characters` });
  }
  if (scheduled_at !== undefined && scheduled_at !== null && scheduled_at !== '') {
    const validation = validateScheduleInput(scheduled_at, { allowPast: false });
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
  }

  try {
    // Find conversation
    const conversations = db.getConversations();
    const conv = conversations.find(c => c.id === convId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Hard suppression blocks even a deliberate one-to-one send. Business
    // dispositions (No / Unqualified / Customer) do not — a human may still
    // reply to someone they marked as a customer.
    const block = db.getSuppressionBlock(conv, { scope: 'individual' });
    if (block) {
      db.logSuppressionEvent(convId, conv.phone_number, 'blocked_send', block.reason,
                             'individual send rejected', req.user && req.user.username);
      return res.status(409).json({
        error: `Cannot message this contact: ${block.label}.`,
        blocked: true,
        reason: block.reason,
        label: block.label
      });
    }

    // Sticky rotation: reuses this contact's pinned DID, or claims the next one.
    const fromNum = db.resolveSenderNumber(convId, from_number);

    const msgData = {
      conversation_id: convId,
      direction: 'outbound',
      from_number: fromNum,
      to_number: conv.phone_number,
      body: body || '',
      media_urls: media_urls || null,
      status: 'queued',
      scheduled_at: scheduled_at || null
    };

    const inserted = db.insertMessage(msgData);
    
    // Broadcast message creation
    broadcast('message_new', inserted);
    broadcast('queue_status', db.getQueueStats());

    // Proactively kick the queue worker in case it's waiting
    queueWorker.processNext();

    res.status(201).json(inserted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.5. Bulk Upload Leads & Campaign Sending
app.post('/api/leads/upload', (req, res) => {
  const { leads, message_template, from_number } = req.body;
  if (!leads || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Leads array is required' });
  }
  if (leads.length > MAX_LEADS_PER_UPLOAD) {
    return res.status(400).json({ error: `Too many leads in one upload (max ${MAX_LEADS_PER_UPLOAD})` });
  }
  if (message_template && message_template.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message template exceeds ${MAX_MESSAGE_LENGTH} characters` });
  }

  try {
    const result = db.bulkImportLeads(leads, message_template || null, from_number || null);
    
    // Broadcast new messages via WebSockets if any
    if (result.messages.length > 0) {
      result.messages.forEach(msg => {
        broadcast('message_new', msg);
      });
      // Wake up queue worker
      queueWorker.processNext();
    }
    
    // Update queue stats on dashboard
    broadcast('queue_status', db.getQueueStats());

    // Structured summary: `messages` and `skipped` are the raw arrays, the
    // rest are the audited counts. imported_count is deliberately gone —
    // it used to include contacts that were then skipped.
    const { messages, skipped, ...counts } = result;
    res.json({ success: true, ...counts, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.6. Send Bulk Message to Selected Conversations
app.post('/api/conversations/bulk-message', (req, res) => {
  const { conversation_ids, message_text, from_number } = req.body;
  if (!conversation_ids || !Array.isArray(conversation_ids)) {
    return res.status(400).json({ error: 'conversation_ids array is required' });
  }
  if (!message_text) {
    return res.status(400).json({ error: 'message_text is required' });
  }
  if (conversation_ids.length > MAX_BULK_RECIPIENTS) {
    return res.status(400).json({ error: `Too many recipients (max ${MAX_BULK_RECIPIENTS})` });
  }
  if (message_text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters` });
  }

  try {
    const { messages, skipped } = db.sendBulkMessages(conversation_ids, message_text, from_number || null);
    
    // Broadcast new messages via WebSockets if any
    if (messages.length > 0) {
      messages.forEach(msg => {
        broadcast('message_new', msg);
      });
      // Wake up queue worker
      queueWorker.processNext();
    }
    
    // Update queue stats on dashboard
    broadcast('queue_status', db.getQueueStats());

    res.json({
      success: true,
      queued_count: messages.length,
      skipped_count: skipped.length,
      skipped_opted_out: skipped.filter(s => s.reason === 'opted_out').length,
      skipped_wrong_number: skipped.filter(s => s.reason === 'wrong_number').length,
      skipped_disposition: skipped.filter(s => String(s.reason).startsWith('disposition_')).length,
      skipped: skipped
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.7. Send Bulk Message to Specific Stages (Campaigns)
app.post('/api/campaigns', (req, res) => {
  const { stages, message_text, from_number } = req.body;
  if (!stages || !Array.isArray(stages) || stages.length === 0) {
    return res.status(400).json({ error: 'stages array is required' });
  }
  if (!message_text) {
    return res.status(400).json({ error: 'message_text is required' });
  }

  try {
    // Find all conversations in target stages
    const placeholders = stages.map(() => '?').join(',');
    const conversations = db.db.prepare(`
      SELECT id FROM conversations WHERE stage IN (${placeholders})
    `).all(...stages);

    const conversationIds = conversations.map(c => c.id);
    if (conversationIds.length === 0) {
      return res.json({
        success: true,
        queued_count: 0,
        message: 'No contacts found in selected stages.'
      });
    }

    const { messages, skipped } = db.sendBulkMessages(conversationIds, message_text, from_number || null);
    
    // Broadcast new messages via WebSockets if any
    if (messages.length > 0) {
      messages.forEach(msg => {
        broadcast('message_new', msg);
      });
      // Wake up queue worker
      queueWorker.processNext();
    }
    
    // Update queue stats on dashboard
    broadcast('queue_status', db.getQueueStats());

    res.json({
      success: true,
      queued_count: messages.length,
      skipped_count: skipped.length,
      skipped_opted_out: skipped.filter(s => s.reason === 'opted_out').length,
      skipped_wrong_number: skipped.filter(s => s.reason === 'wrong_number').length,
      skipped_disposition: skipped.filter(s => String(s.reason).startsWith('disposition_')).length,
      skipped: skipped
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get current settings
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5.5. Get recent queue activity messages
app.get('/api/queue/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const recent = db.getRecentMessages(limit);
    res.json(recent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function configureFractelWebhook(settings, hostUrl) {
  const username = settings.fractel_username;
  const password = settings.fractel_password;
  const senderNumber = settings.fractel_sender_number;
  
  if (!username || !password || !senderNumber) {
    console.log("FracTEL credentials or sender number missing, skipping webhook auto-config.");
    return;
  }

  try {
    console.log("Requesting token for FracTEL webhook configuration...");
    const authRes = await fetch('https://api.fonestorm.com/v2/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, expires: 3600 })
    });
    
    if (!authRes.ok) {
      console.error("FracTEL auth failed for webhook config:", authRes.status);
      return;
    }
    
    const authData = await authRes.json();
    const token = authData.auth && authData.auth.token;
    if (!token) {
      console.error("No token in FracTEL auth response for webhook config");
      return;
    }

    let cleanNumber = senderNumber.replace(/[^\d]/g, '');
    if (cleanNumber.length === 11 && cleanNumber.startsWith('1')) {
      cleanNumber = cleanNumber.substring(1);
    }
    const webhookUrl = `${hostUrl}/webhook/inbound`;
    console.log(`Configuring FracTEL inbound webhook for DID ${cleanNumber} to: ${webhookUrl}`);
    
    const putRes = await fetch(`https://api.fonestorm.com/v2/fonenumbers/${cleanNumber}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({
        sms_options: {
          receive_notify: {
            type: 'Callback',
            method: 'JSON',
            url: webhookUrl
          }
        }
      })
    });

    const putData = await putRes.json();
    console.log("FracTEL webhook configuration response:", JSON.stringify(putData));
  } catch (err) {
    console.error("Failed to auto-configure FracTEL webhook:", err);
  }
}

// 6. Update settings
app.post('/api/settings', async (req, res) => {
  try {
    const updated = db.updateSettings(req.body);
    
    // Determine the host URL dynamically
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const hostUrl = `${protocol}://${host}`;
    
    // Do NOT automatically configure/change webhook settings on FracTEL to protect existing campaigns/apps.
    /*
    configureFractelWebhook(updated, hostUrl).catch(err => {
      console.error("FracTEL webhook config error:", err);
    });
    */

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Get queue status
app.get('/api/queue/status', (req, res) => {
  try {
    const stats = db.getQueueStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Inbound Webhook from Bulkvs
app.post('/webhook/inbound', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`Inbound webhook received from IP ${ip}:`, JSON.stringify(req.body));
  
  const From = req.body.From || req.body.from;
  const To = req.body.To || req.body.to;
  const Message = req.body.Message || req.body.message;
  const MediaURLs = req.body.MediaURLs || (req.body.media ? [req.body.media] : null);
  const DeliveryReceipt = req.body.DeliveryReceipt || req.body.delivery_receipt;
  const RefId = req.body.RefId || req.body.id;

  if (!From) {
    return res.status(400).send('Missing From field');
  }

  try {
    // Handle Bulkvs Delivery Receipts (DLR)
    if (DeliveryReceipt === true || DeliveryReceipt === 'true') {
      console.log(`Handling delivery receipt for RefId: ${RefId}`);
      
      const decodedMsg = decodeURIComponent(Message || '');
      const statMatch = decodedMsg.match(/stat:([A-Z]+)/);
      const errMatch = decodedMsg.match(/err:(\d+)/);
      
      const status = statMatch ? statMatch[1] : '';
      const errCode = errMatch ? errMatch[1] : '';

      // Find original message by RefId
      const targetMsg = db.db.prepare('SELECT * FROM messages WHERE ref_id = ?').get(RefId);
      if (targetMsg) {
        if (status === 'DELIVRD') {
          // Real handset confirmation. Without this the stats can only report
          // carrier acceptance, which is not the same thing.
          db.recordDelivery(targetMsg.id, status);
          console.log(`[dlr] message ${targetMsg.id} confirmed delivered.`);
          broadcast('message_status', {
            id: targetMsg.id,
            status: 'sent',
            delivered: true,
            conversation_id: targetMsg.conversation_id
          });
        } else if (status === 'UNDELIV' || status === 'REJECTD' || status === 'EXPIRED') {
          db.recordCarrierStatus(targetMsg.id, status);
          const errorDetail = `Carrier delivery failed: ${status} (err: ${errCode || 'unknown'})`;
          db.updateMessageStatus(targetMsg.id, 'failed', RefId, errorDetail);
          
          broadcast('message_status', {
            id: targetMsg.id,
            status: 'failed',
            error_message: errorDetail,
            conversation_id: targetMsg.conversation_id
          });
          broadcast('queue_status', db.getQueueStats());
        }
      }
      return res.status(200).send('OK');
    }

    // Get target number
    const toNum = (Array.isArray(To) ? To[0] : To) || '';
    
    // Create/get conversation for sender
    // Normalize From number to database format
    const conv = db.getOrCreateConversation(From);

    // Pin the conversation to whichever of our DIDs they texted, so our reply
    // goes back from the number already showing in their thread.
    if (!conv.assigned_did) {
      const inboundDid = (toNum || '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
      if (db.getFractelDidPool().includes(inboundDid)) {
        db.setConversationDid(conv.id, inboundDid);
      }
    }

    const msgData = {
      conversation_id: conv.id,
      direction: 'inbound',
      from_number: From,
      to_number: toNum,
      body: Message || '',
      media_urls: MediaURLs || null,
      status: 'received'
    };

    // Insert message into database
    const inserted = db.insertMessage(msgData);

    // Broadcast new message via websocket
    broadcast('message_new', inserted);
    
    // Send 200 OK as requested by Bulkvs
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error saving inbound message:', err);
    res.status(500).send('Error saving message');
  }
});

// Serve frontend routing fallback
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Start Server
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`SMS Gateway server listening on port ${port}`);
});
