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
function getCookie(cookieString, name) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

// Middleware
app.use(express.json());

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
    res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`);
    res.json({ success: true, username: session.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const user = db.validateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const session = db.createSession(user.username);
    res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`);
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
    res.setHeader('Set-Cookie', `session_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
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

// Serve main static assets
app.use(express.static(path.resolve(__dirname, 'public')));

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
  const { phone_number, name } = req.body;
  if (!phone_number) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const conv = db.getOrCreateConversation(phone_number, name);
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

// 4. Queue a message (Outbound)
app.post('/api/conversations/:id/messages', (req, res) => {
  const convId = parseInt(req.params.id, 10);
  const { body, media_urls, scheduled_at, from_number } = req.body;
  
  try {
    // Find conversation
    const conversations = db.getConversations();
    const conv = conversations.find(c => c.id === convId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const settings = db.getSettings();
    const fromNum = from_number || settings.sender_number || '+18887885527';

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

    res.json({
      success: true,
      imported_count: result.conversations.length,
      queued_count: result.messages.length
    });
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

  try {
    const messages = db.sendBulkMessages(conversation_ids, message_text, from_number || null);
    
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
      queued_count: messages.length
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

    const messages = db.sendBulkMessages(conversationIds, message_text, from_number || null);
    
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
      queued_count: messages.length
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
          console.log(`Outbound message ${targetMsg.id} delivered.`);
        } else if (status === 'UNDELIV' || status === 'REJECTD' || status === 'EXPIRED') {
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
