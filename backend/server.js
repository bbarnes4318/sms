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

// Middleware
app.use(express.json());
app.use(express.static(path.resolve(__dirname, 'public')));

// Store WebSocket clients
const clients = new Set();

wss.on('connection', (ws) => {
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

// 3. Get messages for a conversation
app.get('/api/conversations/:id/messages', (req, res) => {
  const convId = parseInt(req.params.id, 10);
  try {
    const messages = db.getMessages(convId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Queue a message (Outbound)
app.post('/api/conversations/:id/messages', (req, res) => {
  const convId = parseInt(req.params.id, 10);
  const { body, media_urls, scheduled_at } = req.body;
  
  try {
    // Find conversation
    const conversations = db.getConversations();
    const conv = conversations.find(c => c.id === convId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const settings = db.getSettings();
    const fromNum = settings.sender_number || '+18887885527';

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
  const { leads, message_template } = req.body;
  if (!leads || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Leads array is required' });
  }

  try {
    const result = db.bulkImportLeads(leads, message_template || null);
    
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

// 5. Get current settings
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Update settings
app.post('/api/settings', (req, res) => {
  try {
    const updated = db.updateSettings(req.body);
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
  
  const { From, To, Message, MediaURLs } = req.body;
  if (!From) {
    return res.status(400).send('Missing From field');
  }

  try {
    // Get target number
    const toNum = (To && To[0]) || '';
    
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
