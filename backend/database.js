const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure database directory exists
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Initialize database schema
function initDatabase() {
  // Create tables
  db.prepare(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      name TEXT,
      last_message_text TEXT,
      last_message_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      direction TEXT CHECK(direction IN ('inbound', 'outbound')) NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT,
      media_urls TEXT, -- JSON string array of URLs
      status TEXT CHECK(status IN ('queued', 'sending', 'sent', 'failed', 'received')) NOT NULL,
      ref_id TEXT,
      error_message TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT UNIQUE PRIMARY KEY,
      value TEXT
    )
  `).run();

  // Create indexes
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_number)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)`).run();

  // Insert default settings if they don't exist
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('bulkvs_username', 'jimmy@getlifeassurance.com');
  insertSetting.run('bulkvs_token', '50e77367256f3bd823f44d13dc1e8d17');
  insertSetting.run('sender_number', '+18887885527');
  insertSetting.run('send_interval_ms', '2000'); // 2 seconds between sends
}

// Helpers
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(row => {
    settings[row.key] = row.value;
  });
  return settings;
}

function updateSettings(settingsObj) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const transaction = db.transaction((obj) => {
    for (const [key, val] of Object.entries(obj)) {
      stmt.run(key, String(val));
    }
  });
  transaction(settingsObj);
  return getSettings();
}

function getConversations() {
  return db.prepare(`
    SELECT * FROM conversations 
    ORDER BY last_message_at DESC, created_at DESC
  `).all();
}

function getOrCreateConversation(phoneNumber, contactName = null) {
  // Normalize phone number: strip non-digits except +
  const cleanPhone = phoneNumber.replace(/[^\d+]/g, '');
  
  // Try to find
  let conv = db.prepare('SELECT * FROM conversations WHERE phone_number = ?').get(cleanPhone);
  if (!conv) {
    try {
      const result = db.prepare('INSERT INTO conversations (phone_number, name) VALUES (?, ?)').run(cleanPhone, contactName);
      conv = {
        id: result.lastInsertRowid,
        phone_number: cleanPhone,
        name: contactName,
        last_message_text: null,
        last_message_at: null,
        created_at: new Date().toISOString()
      };
    } catch (e) {
      // Handle race condition
      conv = db.prepare('SELECT * FROM conversations WHERE phone_number = ?').get(cleanPhone);
    }
  } else if (contactName && conv.name !== contactName) {
    db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(contactName, conv.id);
    conv.name = contactName;
  }
  return conv;
}

function getMessages(conversationId) {
  return db.prepare(`
    SELECT * FROM messages 
    WHERE conversation_id = ? 
    ORDER BY created_at ASC, id ASC
  `).all(conversationId);
}

function insertMessage(msg) {
  const result = db.prepare(`
    INSERT INTO messages (
      conversation_id, direction, from_number, to_number, body, media_urls, status, scheduled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.conversation_id,
    msg.direction,
    msg.from_number,
    msg.to_number,
    msg.body || '',
    msg.media_urls ? JSON.stringify(msg.media_urls) : null,
    msg.status,
    msg.scheduled_at || null
  );
  
  const inserted = {
    id: result.lastInsertRowid,
    ...msg
  };

  // Update last message in conversation
  db.prepare(`
    UPDATE conversations 
    SET last_message_text = ?, last_message_at = datetime('now', 'localtime') 
    WHERE id = ?
  `).run(msg.body || (msg.media_urls ? '[Attachment]' : ''), msg.conversation_id);

  return inserted;
}

function updateMessageStatus(id, status, refId = null, errorMessage = null) {
  if (status === 'sent') {
    db.prepare(`
      UPDATE messages 
      SET status = ?, ref_id = ?, sent_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(status, refId, id);
  } else if (status === 'failed') {
    db.prepare(`
      UPDATE messages 
      SET status = ?, error_message = ?
      WHERE id = ?
    `).run(status, errorMessage, id);
  } else {
    db.prepare(`
      UPDATE messages 
      SET status = ?
      WHERE id = ?
    `).run(status, id);
  }
}

// Queue functions
function getNextQueuedMessage() {
  return db.prepare(`
    SELECT * FROM messages 
    WHERE status = 'queued' 
    AND (scheduled_at IS NULL OR scheduled_at <= datetime('now', 'localtime'))
    ORDER BY created_at ASC, id ASC 
    LIMIT 1
  `).get();
}

function getQueueStats() {
  const stats = db.prepare(`
    SELECT 
      SUM(case when status='queued' then 1 else 0 end) as queued,
      SUM(case when status='sending' then 1 else 0 end) as sending,
      SUM(case when status='sent' then 1 else 0 end) as sent,
      SUM(case when status='failed' then 1 else 0 end) as failed
    FROM messages
  `).get();
  
  return {
    queued: stats.queued || 0,
    sending: stats.sending || 0,
    sent: stats.sent || 0,
    failed: stats.failed || 0
  };
}

module.exports = {
  db,
  initDatabase,
  getSettings,
  updateSettings,
  getConversations,
  getOrCreateConversation,
  getMessages,
  insertMessage,
  updateMessageStatus,
  getNextQueuedMessage,
  getQueueStats
};
