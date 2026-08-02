const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
      stage TEXT DEFAULT 'Stage 1',
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

  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TEXT NOT NULL
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
  insertSetting.run('fractel_username', '');
  insertSetting.run('fractel_password', '');
  insertSetting.run('fractel_sender_number', '8653456051');
  insertSetting.run('fractel_brand_id', 'B7PS8UH');
  insertSetting.run('fractel_enabled_dids', '3212372724,3215777735,3215777754,4072049626,4244204981,6283888618,6894658835,7272865079,7272882904,8653456051');

  // Migration: Add stage column if not exists
  const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();
  const hasStage = tableInfo.some(column => column.name === 'stage');
  if (!hasStage) {
    db.prepare("ALTER TABLE conversations ADD COLUMN stage TEXT DEFAULT 'Stage 1'").run();
    console.log("Database migration: Added 'stage' column to conversations table.");
  }
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_stage ON conversations(stage)`).run();

  // Migration: Add unread column if not exists
  const hasUnread = tableInfo.some(column => column.name === 'unread');
  if (!hasUnread) {
    db.prepare("ALTER TABLE conversations ADD COLUMN unread INTEGER DEFAULT 0").run();
    console.log("Database migration: Added 'unread' column to conversations table.");
  }

  // Migration: Add city column if not exists
  const hasCity = tableInfo.some(column => column.name === 'city');
  if (!hasCity) {
    db.prepare("ALTER TABLE conversations ADD COLUMN city TEXT").run();
    console.log("Database migration: Added 'city' column to conversations table.");
  }

  // Migration: Lead disposition columns (appointment / follow_up / no / unqualified / customer)
  const dispositionColumns = [
    ['disposition', "ALTER TABLE conversations ADD COLUMN disposition TEXT"],
    ['disposition_at', "ALTER TABLE conversations ADD COLUMN disposition_at TEXT"],
    ['scheduled_at', "ALTER TABLE conversations ADD COLUMN scheduled_at TEXT"],
    ['disposition_note', "ALTER TABLE conversations ADD COLUMN disposition_note TEXT"]
  ];
  dispositionColumns.forEach(([name, sql]) => {
    if (!tableInfo.some(column => column.name === name)) {
      db.prepare(sql).run();
      console.log(`Database migration: Added '${name}' column to conversations table.`);
    }
  });
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_disposition ON conversations(disposition)`).run();

  // Run database migration to normalize existing conversation numbers
  migrateAndNormalizeDatabase();

  // Reset any stuck sending messages to queued status on startup
  try {
    const result = db.prepare("UPDATE messages SET status = 'queued' WHERE status = 'sending'").run();
    if (result.changes > 0) {
      console.log(`Database initialized: Reset ${result.changes} stuck 'sending' messages back to 'queued'.`);
    }
  } catch (err) {
    console.error("Failed to reset stuck sending messages:", err);
  }
}

function normalizePhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) {
    return cleaned === '+' ? '' : cleaned;
  }
  if (cleaned.length === 10) {
    return '+1' + cleaned;
  }
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+' + cleaned;
  }
  return cleaned;
}

function migrateAndNormalizeDatabase() {
  console.log("Starting database normalization and migration...");
  const conversations = db.prepare('SELECT * FROM conversations').all();
  
  const mergeStmt = db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?');
  const deleteConvStmt = db.prepare('DELETE FROM conversations WHERE id = ?');
  const updateConvPhoneStmt = db.prepare('UPDATE conversations SET phone_number = ? WHERE id = ?');
  const updateLastMessageStmt = db.prepare(`
    UPDATE conversations 
    SET last_message_text = ?, last_message_at = ? 
    WHERE id = ?
  `);

  db.transaction(() => {
    const normMap = {};

    for (const c of conversations) {
      const normalized = normalizePhoneNumber(c.phone_number);
      
      if (normMap[normalized]) {
        const targetConv = normMap[normalized];
        console.log(`Merging duplicate conversation ID ${c.id} (${c.phone_number}) into target ID ${targetConv.id} (${normalized})...`);
        
        // Merge messages
        mergeStmt.run(targetConv.id, c.id);
        
        // Determine latest last_message_at
        let latestText = targetConv.last_message_text;
        let latestAt = targetConv.last_message_at;
        
        if (c.last_message_at) {
          if (!latestAt || new Date(c.last_message_at) > new Date(latestAt)) {
            latestText = c.last_message_text;
            latestAt = c.last_message_at;
          }
        }
        
        // Update target conversation last message details
        updateLastMessageStmt.run(latestText, latestAt, targetConv.id);
        
        // Update target name if not set
        if (!targetConv.name && c.name) {
          db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(c.name, targetConv.id);
          targetConv.name = c.name;
        }

        // Delete duplicate conversation
        deleteConvStmt.run(c.id);
      } else {
        if (normalized !== c.phone_number) {
          console.log(`Updating conversation ID ${c.id} phone number: ${c.phone_number} -> ${normalized}`);
          updateConvPhoneStmt.run(normalized, c.id);
          c.phone_number = normalized;
        }
        normMap[normalized] = c;
      }
    }
  })();
  console.log("Database normalization and migration completed.");
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
    SELECT c.*,
           (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) as last_message_direction,
           (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND direction = 'inbound') as last_inbound_at,
           (SELECT body FROM messages WHERE conversation_id = c.id AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT 1) as last_inbound_text
    FROM conversations c
    ORDER BY 
      CASE WHEN last_inbound_at IS NOT NULL THEN 0 ELSE 1 END,
      last_inbound_at DESC,
      last_message_at DESC,
      created_at DESC
  `).all();
}

function getOrCreateConversation(phoneNumber, contactName = null, city = null) {
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  if (!cleanPhone) {
    throw new Error("Invalid phone number");
  }
  
  // Try to find
  let conv = db.prepare('SELECT * FROM conversations WHERE phone_number = ?').get(cleanPhone);
  if (!conv) {
    try {
      const result = db.prepare('INSERT INTO conversations (phone_number, name, city) VALUES (?, ?, ?)').run(cleanPhone, contactName, city);
      conv = {
        id: result.lastInsertRowid,
        phone_number: cleanPhone,
        name: contactName,
        city: city,
        last_message_text: null,
        last_message_at: null,
        created_at: new Date().toISOString()
      };
    } catch (e) {
      // Handle race condition
      conv = db.prepare('SELECT * FROM conversations WHERE phone_number = ?').get(cleanPhone);
    }
  } else {
    let needsUpdate = false;
    const updateFields = [];
    const updateValues = [];

    if (contactName && conv.name !== contactName) {
      conv.name = contactName;
      updateFields.push("name = ?");
      updateValues.push(contactName);
      needsUpdate = true;
    }
    if (city && conv.city !== city) {
      conv.city = city;
      updateFields.push("city = ?");
      updateValues.push(city);
      needsUpdate = true;
    }

    if (needsUpdate) {
      updateValues.push(conv.id);
      db.prepare(`UPDATE conversations SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);
    }
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

  // Auto-transition to responded substage if inbound reply
  if (msg.direction === 'inbound') {
    db.prepare("UPDATE conversations SET unread = 1 WHERE id = ?").run(msg.conversation_id);
    const conv = db.prepare('SELECT stage FROM conversations WHERE id = ?').get(msg.conversation_id);
    if (conv) {
      let newStage = conv.stage;
      if (conv.stage === 'Stage 1') newStage = 'Stage 1-Responded';
      else if (conv.stage === 'Stage 2') newStage = 'Stage 2-Responded';
      else if (conv.stage === 'Stage 3') newStage = 'Stage 3-Responded';
      
      if (newStage !== conv.stage) {
        db.prepare('UPDATE conversations SET stage = ? WHERE id = ?').run(newStage, msg.conversation_id);
      }
    }
  }

  // Auto-transition if manual outbound message sent directly
  if (msg.direction === 'outbound') {
    db.prepare("UPDATE conversations SET unread = 0 WHERE id = ?").run(msg.conversation_id);
    const conv = db.prepare('SELECT stage FROM conversations WHERE id = ?').get(msg.conversation_id);
    if (conv && ['Stage 1', 'Stage 2', 'Stage 3'].includes(conv.stage)) {
      const outboundCount = db.prepare(`
        SELECT COUNT(*) as count FROM messages 
        WHERE conversation_id = ? AND direction = 'outbound' AND status = 'sent'
      `).get(msg.conversation_id).count;

      let newStage = 'Stage 1';
      if (outboundCount === 1) newStage = 'Stage 2';
      else if (outboundCount >= 2) newStage = 'Stage 3';

      if (newStage !== conv.stage) {
        db.prepare('UPDATE conversations SET stage = ? WHERE id = ?').run(newStage, msg.conversation_id);
      }
    }
  }

  return inserted;
}

function updateMessageStatus(id, status, refId = null, errorMessage = null) {
  if (status === 'sent') {
    db.prepare(`
      UPDATE messages 
      SET status = ?, ref_id = ?, sent_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(status, refId, id);

    // Update conversation stage if outbound
    const msg = db.prepare('SELECT conversation_id, direction FROM messages WHERE id = ?').get(id);
    if (msg && msg.direction === 'outbound') {
      const conv = db.prepare('SELECT stage FROM conversations WHERE id = ?').get(msg.conversation_id);
      if (conv && ['Stage 1', 'Stage 2', 'Stage 3'].includes(conv.stage)) {
        const outboundCount = db.prepare(`
          SELECT COUNT(*) as count FROM messages 
          WHERE conversation_id = ? AND direction = 'outbound' AND status = 'sent'
        `).get(msg.conversation_id).count;

        let newStage = 'Stage 1';
        if (outboundCount === 2) newStage = 'Stage 2';
        else if (outboundCount >= 3) newStage = 'Stage 3';

        if (newStage !== conv.stage) {
          db.prepare('UPDATE conversations SET stage = ? WHERE id = ?').run(newStage, msg.conversation_id);
        }
      }
    }
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

/* ------------------------------------------------------------------
 * Bulk-send suppression
 *
 * Nobody in these states may be reached by a campaign, a bulk message
 * or a CSV re-import. To message one of them, open the conversation
 * and send individually.
 *
 * The keyword lists mirror NEGATIVE_EXACT / NEGATIVE_PHRASES in
 * public/app.js — keep the two in sync.
 * ------------------------------------------------------------------ */
const BLOCKED_DISPOSITIONS = ['no', 'unqualified', 'customer'];

const OPT_OUT_EXACT = [
  'no', 'nope', 'nah', 'na', 'no thanks', 'no thank you', 'no thx', 'nope thanks',
  'not interested', 'im not interested', 'i am not interested', 'no interest',
  'stop', 'stopall', 'stop all', 'end', 'quit', 'cancel', 'unsubscribe',
  'unsub', 'optout', 'opt out', 'revoke', 'remove', 'remove me', 'delete me',
  'take me off', 'go away', 'leave me alone', 'fuck off', 'fuck you', 'f off',
  'piss off', 'never', 'no way', 'pass', 'hard pass', 'wrong number'
];

const OPT_OUT_PHRASES = [
  'remove me from your list', 'remove me from the list', 'remove my number',
  'take me off your list', 'take me off the list', 'take me off your',
  'off your list', 'off of your list', 'delete my number',
  'stop texting', 'stop messaging', 'stop contacting', 'stop calling',
  'do not text', "don't text", 'do not contact', "don't contact",
  'do not call', "don't call", 'not interested', 'no longer interested',
  'unsubscribe', 'opt me out', 'fuck off', 'fuck you', 'leave me alone',
  'quit texting', 'quit messaging', 'lose my number'
];

function normalizeReplyText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOptOutReply(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;

  if (OPT_OUT_EXACT.includes(normalized)) return true;
  if (OPT_OUT_PHRASES.some(phrase => normalized.includes(phrase))) return true;

  const words = normalized.split(' ');
  return words.length <= 4 && OPT_OUT_EXACT.includes(words[0]);
}

function getLastInboundBody(conversationId) {
  const row = db.prepare(`
    SELECT body FROM messages
    WHERE conversation_id = ? AND direction = 'inbound'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(conversationId);
  return row ? row.body : null;
}

// Returns a reason string when the contact must be skipped, otherwise null.
function getBulkSendBlockReason(conv) {
  if (!conv) return 'missing';
  if (conv.disposition && BLOCKED_DISPOSITIONS.includes(conv.disposition)) {
    return conv.disposition;
  }
  if (isOptOutReply(getLastInboundBody(conv.id))) return 'opted_out';
  return null;
}

function bulkImportLeads(leads, messageTemplate, fromNumber = null) {
  const settings = getSettings();
  const fromNum = fromNumber || settings.sender_number || '+18887885527';
  
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      conversation_id, direction, from_number, to_number, body, status
    ) VALUES (?, 'outbound', ?, ?, ?, 'queued')
  `);
  
  const updateConvStmt = db.prepare(`
    UPDATE conversations 
    SET last_message_text = ?, last_message_at = datetime('now', 'localtime'), stage = 'Stage 1'
    WHERE id = ?
  `);

  const insertedMessages = [];
  const insertedConvs = [];
  const skipped = [];

  const transaction = db.transaction((leadsList) => {
    for (const lead of leadsList) {
      if (!lead.phone_number) continue;

      const conv = getOrCreateConversation(lead.phone_number, lead.name, lead.city);
      insertedConvs.push(conv);

      // Re-importing must not resurrect someone who opted out or was closed
      const blockReason = getBulkSendBlockReason(conv);
      if (blockReason) {
        skipped.push({ id: conv.id, phone_number: conv.phone_number, reason: blockReason });
        continue;
      }

      // Reset stage to Stage 1 upon re-import/new import
      db.prepare("UPDATE conversations SET stage = 'Stage 1' WHERE id = ?").run(conv.id);

      if (messageTemplate) {
        // Replace placeholders
        let body = messageTemplate;
        const nameVal = lead.name || '';
        const cityVal = lead.city || '';
        body = body.replace(/\[Name\]/gi, nameVal);
        body = body.replace(/\[City\]/gi, cityVal);
        
        const result = insertMessageStmt.run(conv.id, fromNum, conv.phone_number, body);
        insertedMessages.push({
          id: result.lastInsertRowid,
          conversation_id: conv.id,
          direction: 'outbound',
          from_number: fromNum,
          to_number: conv.phone_number,
          body: body,
          status: 'queued'
        });
        
        updateConvStmt.run(body, conv.id);
      }
    }
  });

  transaction(leads);
  return { conversations: insertedConvs, messages: insertedMessages, skipped };
}

function sendBulkMessages(conversationIds, messageTemplate, fromNumber = null) {
  const settings = getSettings();
  const fromNum = fromNumber || settings.sender_number || '+18887885527';
  
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      conversation_id, direction, from_number, to_number, body, status
    ) VALUES (?, 'outbound', ?, ?, ?, 'queued')
  `);
  
  const updateConvStmt = db.prepare(`
    UPDATE conversations 
    SET last_message_text = ?, last_message_at = datetime('now', 'localtime') 
    WHERE id = ?
  `);

  const updateConvStageStmt = db.prepare(`
    UPDATE conversations 
    SET stage = ? 
    WHERE id = ?
  `);

  const getConvStmt = db.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `);

  const insertedMessages = [];
  const skipped = [];

  const transaction = db.transaction((ids) => {
    for (const id of ids) {
      const conv = getConvStmt.get(id);
      if (!conv) continue;

      // Never blast someone who opted out or was dispositioned out
      const blockReason = getBulkSendBlockReason(conv);
      if (blockReason) {
        skipped.push({ id: conv.id, phone_number: conv.phone_number, reason: blockReason });
        continue;
      }

      // Calculate next stage for follow-up message
      const outboundCount = db.prepare(`
        SELECT COUNT(*) as count FROM messages 
        WHERE conversation_id = ? AND direction = 'outbound' AND status = 'sent'
      `).get(conv.id).count;

      let nextStage = 'Stage 1';
      if (outboundCount === 1) nextStage = 'Stage 2';
      else if (outboundCount >= 2) nextStage = 'Stage 3';

      updateConvStageStmt.run(nextStage, conv.id);

      // Replace placeholders
      let body = messageTemplate;
      const nameVal = conv.name || '';
      const cityVal = conv.city || '';
      body = body.replace(/\[Name\]/gi, nameVal);
      body = body.replace(/\[City\]/gi, cityVal);
      
      const result = insertMessageStmt.run(conv.id, fromNum, conv.phone_number, body);
      insertedMessages.push({
        id: result.lastInsertRowid,
        conversation_id: conv.id,
        direction: 'outbound',
        from_number: fromNum,
        to_number: conv.phone_number,
        body: body,
        status: 'queued'
      });
      
      updateConvStmt.run(body, conv.id);
    }
  });

  transaction(conversationIds);
  return { messages: insertedMessages, skipped };
}

function deleteConversation(id) {
  const deleteMsgs = db.prepare('DELETE FROM messages WHERE conversation_id = ?');
  const deleteConv = db.prepare('DELETE FROM conversations WHERE id = ?');
  const transaction = db.transaction((convId) => {
    deleteMsgs.run(convId);
    deleteConv.run(convId);
  });
  return transaction(id);
}

function getRecentMessages(limit = 10) {
  return db.prepare(`
    SELECT 
      m.id, 
      m.conversation_id, 
      m.direction, 
      m.from_number, 
      m.to_number, 
      m.body, 
      m.status, 
      m.error_message,
      m.created_at,
      c.name as contact_name
    FROM messages m
    LEFT JOIN conversations c ON m.conversation_id = c.id
    ORDER BY m.id DESC
    LIMIT ?
  `).all(limit);
}

function markConversationRead(id) {
  return db.prepare("UPDATE conversations SET unread = 0 WHERE id = ?").run(id);
}

// Lead dispositions. 'appointment' and 'follow_up' carry a scheduled date/time;
// passing null clears the disposition and returns the lead to the New tab.
const VALID_DISPOSITIONS = ['appointment', 'follow_up', 'no', 'unqualified', 'customer'];

function setConversationDisposition(id, disposition, scheduledAt = null, note = null) {
  if (disposition !== null && !VALID_DISPOSITIONS.includes(disposition)) {
    throw new Error(`Invalid disposition: ${disposition}`);
  }
  if ((disposition === 'appointment' || disposition === 'follow_up') && !scheduledAt) {
    throw new Error(`A date and time is required for the '${disposition}' disposition`);
  }

  // Only the scheduled dispositions keep a date on the record
  const keepsSchedule = disposition === 'appointment' || disposition === 'follow_up';

  db.prepare(`
    UPDATE conversations
    SET disposition = ?,
        disposition_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', 'localtime') END,
        scheduled_at = ?,
        disposition_note = ?
    WHERE id = ?
  `).run(
    disposition,
    disposition,
    keepsSchedule ? scheduledAt : null,
    note || null,
    id
  );

  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

/* ------------------------------------------------------------------
 * Performance stats
 *
 * All dates are naive local 'YYYY-MM-DD HH:MM:SS' strings, matching
 * datetime('now','localtime') used everywhere else, so date() works
 * directly without timezone conversion.
 * ------------------------------------------------------------------ */
function getStats(fromDate, toDate) {
  const range = [fromDate, toDate];

  // Outbound volume and delivery outcome
  const outbound = db.prepare(`
    SELECT
      COUNT(*) as attempted,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status IN ('queued', 'sending') THEN 1 ELSE 0 END) as in_flight,
      COUNT(DISTINCT conversation_id) as contacts_reached
    FROM messages
    WHERE direction = 'outbound' AND date(created_at) BETWEEN ? AND ?
  `).get(...range);

  // Inbound replies, classified in JS so the keyword list stays in one place
  const inboundRows = db.prepare(`
    SELECT conversation_id, body
    FROM messages
    WHERE direction = 'inbound' AND date(created_at) BETWEEN ? AND ?
  `).all(...range);

  let positive = 0;
  let negative = 0;
  const responders = new Set();
  const positiveResponders = new Set();

  inboundRows.forEach(row => {
    responders.add(row.conversation_id);
    if (isOptOutReply(row.body)) {
      negative++;
    } else {
      positive++;
      positiveResponders.add(row.conversation_id);
    }
  });

  // Daily series for the chart
  const daily = db.prepare(`
    SELECT
      date(created_at) as day,
      SUM(CASE WHEN direction = 'outbound' AND status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN direction = 'outbound' AND status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as replies
    FROM messages
    WHERE date(created_at) BETWEEN ? AND ?
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(...range);

  // Dispositions applied during the window
  const dispositionRows = db.prepare(`
    SELECT disposition, COUNT(*) as count
    FROM conversations
    WHERE disposition IS NOT NULL AND date(disposition_at) BETWEEN ? AND ?
    GROUP BY disposition
  `).all(...range);

  const dispositions = { appointment: 0, follow_up: 0, no: 0, unqualified: 0, customer: 0 };
  dispositionRows.forEach(row => {
    if (row.disposition in dispositions) dispositions[row.disposition] = row.count;
  });

  // New contacts first created in the window
  const newLeads = db.prepare(`
    SELECT COUNT(*) as count FROM conversations WHERE date(created_at) BETWEEN ? AND ?
  `).get(...range).count;

  // Average minutes between our last outbound and their reply
  const replyLag = db.prepare(`
    SELECT AVG(
      (julianday(m.created_at) - julianday((
        SELECT MAX(o.created_at) FROM messages o
        WHERE o.conversation_id = m.conversation_id
          AND o.direction = 'outbound'
          AND o.created_at < m.created_at
      ))) * 1440
    ) as avg_minutes
    FROM messages m
    WHERE m.direction = 'inbound' AND date(m.created_at) BETWEEN ? AND ?
  `).get(...range).avg_minutes;

  // Hour of day that draws the most replies
  const peakHour = db.prepare(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM messages
    WHERE direction = 'inbound' AND date(created_at) BETWEEN ? AND ?
    GROUP BY hour
    ORDER BY count DESC, hour ASC
    LIMIT 1
  `).get(...range);

  const attempted = outbound.attempted || 0;
  const delivered = outbound.delivered || 0;
  const responses = inboundRows.length;

  const rate = (numerator, denominator) =>
    denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

  return {
    from: fromDate,
    to: toDate,
    sent: {
      attempted,
      delivered,
      failed: outbound.failed || 0,
      in_flight: outbound.in_flight || 0,
      contacts_reached: outbound.contacts_reached || 0,
      delivery_rate: rate(delivered, delivered + (outbound.failed || 0))
    },
    responses: {
      total: responses,
      unique_responders: responders.size,
      positive,
      negative,
      positive_responders: positiveResponders.size,
      response_rate: rate(responders.size, outbound.contacts_reached || 0),
      positive_rate_of_replies: rate(positive, responses),
      positive_rate_of_sent: rate(positiveResponders.size, outbound.contacts_reached || 0),
      negative_rate_of_replies: rate(negative, responses)
    },
    dispositions,
    new_leads: newLeads,
    avg_reply_minutes: replyLag === null ? null : Math.round(replyLag),
    peak_reply_hour: peakHour ? parseInt(peakHour.hour, 10) : null,
    daily
  };
}

// Password Hashing
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === checkHash;
}

// User CRUD & Validation
function countUsers() {
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return row ? row.count : 0;
}

function createUser(username, password) {
  const passwordHash = hashPassword(password);
  return db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username.trim().toLowerCase(), passwordHash);
}

function validateUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user) return null;
  if (verifyPassword(password, user.password_hash)) {
    return { id: user.id, username: user.username };
  }
  return null;
}

// Sessions Management
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  // Expires in 7 days
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)').run(token, username.trim().toLowerCase(), expiresAt);
  return { token, username, expires_at: expiresAt };
}

function validateSession(token) {
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  
  const now = new Date().toISOString();
  if (session.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  
  return session;
}

function deleteSession(token) {
  return db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
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
  getQueueStats,
  bulkImportLeads,
  sendBulkMessages,
  deleteConversation,
  getRecentMessages,
  markConversationRead,
  setConversationDisposition,
  VALID_DISPOSITIONS,
  BLOCKED_DISPOSITIONS,
  isOptOutReply,
  getBulkSendBlockReason,
  getStats,
  countUsers,
  createUser,
  validateUser,
  createSession,
  validateSession,
  deleteSession
};

