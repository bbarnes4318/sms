const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const classification = require('./public/lib/classification');

// SMS_DB_PATH lets tests point at a throwaway database. Production leaves it
// unset and gets the file next to this module, exactly as before.
const dbPath = process.env.SMS_DB_PATH || path.resolve(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// FracTEL DIDs cleared for sending. Every number here was verified by an actual
// send against the carrier, not just by its API attributes - see below.
//
// These four are provisioned identically in the FracTEL API (SMS/MMS enabled,
// 10DLC campaign C6R7BB9, on-net, Local, tier X) yet the carrier rejects every
// send from them with HTTP 400 "Message NOT sent":
//     3213426066, 3213426074, 4072049626, 7272865079
// The cause is not visible through the API and needs FracTEL support to clear.
// Add them back here once they send successfully.
//
// Also excluded: 3212372724 and 4244204981, which are not attached to any 10DLC
// campaign, so carriers filter their traffic.
//
// All ten numbers still point their inbound webhook at /webhook/inbound, so
// replies keep reaching the app even for numbers we cannot currently send from.
const FRACTEL_DID_POOL = [
  '3215777735', '3215777754', '6283888618',
  '6894658835', '7272882904', '8653456051'
];
const FRACTEL_DID_POOL_VERSION = '3';

// Sentinel accepted in place of a from_number to request round-robin selection.
const ROTATE_SENDER = 'rotate';

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

  db.prepare(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      phone_number TEXT,
      note_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `).run();

  // Create indexes
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_number)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_notes_conversation ON notes(conversation_id)`).run();

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
  insertSetting.run('fractel_enabled_dids', FRACTEL_DID_POOL.join(','));
  insertSetting.run('fractel_rotation_index', '0');

  // Migration: force the DID pool to the vetted rotation set. 3212372724 and
  // 4244204981 were dropped because they are not attached to 10DLC campaign
  // C6R7BB9, so carriers filter traffic sent from them.
  const didPoolVersion = db.prepare("SELECT value FROM settings WHERE key = 'fractel_did_pool_version'").get();
  if (!didPoolVersion || didPoolVersion.value !== FRACTEL_DID_POOL_VERSION) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'fractel_enabled_dids'").run(FRACTEL_DID_POOL.join(','));
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('fractel_did_pool_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(FRACTEL_DID_POOL_VERSION);
    console.log(`Database migration: FracTEL DID rotation pool set to ${FRACTEL_DID_POOL.length} numbers.`);
  }

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

  // Migration: Add zip column if not exists
  const hasZip = tableInfo.some(column => column.name === 'zip');
  if (!hasZip) {
    db.prepare("ALTER TABLE conversations ADD COLUMN zip TEXT").run();
    console.log("Database migration: Added 'zip' column to conversations table.");
  }

  // Migration: Add assigned_did column. Holds the FracTEL number this contact
  // is pinned to, so every message in a thread comes from the same sender.
  const hasAssignedDid = tableInfo.some(column => column.name === 'assigned_did');
  if (!hasAssignedDid) {
    db.prepare("ALTER TABLE conversations ADD COLUMN assigned_did TEXT").run();
    console.log("Database migration: Added 'assigned_did' column to conversations table.");
  }

  // Migration: permanent, auditable contact suppression.
  //
  // Suppression is stored, never inferred from the latest reply. A contact who
  // texts STOP and then texts again later stays suppressed until someone runs
  // the explicit re-opt-in workflow.
  const suppressionColumns = [
    // Reply classification of the most recent inbound message (display only).
    ['reply_classification', "ALTER TABLE conversations ADD COLUMN reply_classification TEXT"],
    // Hard suppression flag. 1 = do not contact.
    ['opted_out', "ALTER TABLE conversations ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0"],
    ['opted_out_at', "ALTER TABLE conversations ADD COLUMN opted_out_at TEXT"],
    // 'inbound_keyword' | 'manual' | 'backfill' | 'import'
    ['opt_out_source', "ALTER TABLE conversations ADD COLUMN opt_out_source TEXT"],
    // Verbatim message that triggered it, kept for the audit trail.
    ['opt_out_text', "ALTER TABLE conversations ADD COLUMN opt_out_text TEXT"],
    ['opted_in_at', "ALTER TABLE conversations ADD COLUMN opted_in_at TEXT"],
    ['opted_in_by', "ALTER TABLE conversations ADD COLUMN opted_in_by TEXT"],
    ['wrong_number', "ALTER TABLE conversations ADD COLUMN wrong_number INTEGER NOT NULL DEFAULT 0"],
    ['wrong_number_at', "ALTER TABLE conversations ADD COLUMN wrong_number_at TEXT"],
    ['suppression_reason', "ALTER TABLE conversations ADD COLUMN suppression_reason TEXT"]
  ];
  suppressionColumns.forEach(([name, sql]) => {
    if (!tableInfo.some(column => column.name === name)) {
      db.prepare(sql).run();
      console.log(`Database migration: Added '${name}' column to conversations table.`);
    }
  });
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_opted_out ON conversations(opted_out)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_wrong_number ON conversations(wrong_number)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_classification ON conversations(reply_classification)`).run();

  // Migration: real carrier delivery receipts.
  //
  // The messages.status CHECK constraint cannot take a new value without
  // rebuilding the table, so delivery is tracked alongside it. status='sent'
  // means "carrier accepted"; delivered_at set means the carrier confirmed
  // handset delivery via DLR.
  const messageInfo = db.prepare("PRAGMA table_info(messages)").all();
  const messageColumns = [
    ['delivered_at', "ALTER TABLE messages ADD COLUMN delivered_at TEXT"],
    ['carrier_status', "ALTER TABLE messages ADD COLUMN carrier_status TEXT"]
  ];
  messageColumns.forEach(([name, sql]) => {
    if (!messageInfo.some(column => column.name === name)) {
      db.prepare(sql).run();
      console.log(`Database migration: Added '${name}' column to messages table.`);
    }
  });
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction)`).run();

  // Audit log for suppression decisions and blocked sends.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS suppression_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      phone_number TEXT,
      event TEXT NOT NULL,
      reason TEXT,
      detail TEXT,
      actor TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_suppression_events_conv ON suppression_events(conversation_id)`).run();

  // Reminder delivery state, so a reminder fires once and survives restarts.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS reminder_state (
      conversation_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      tier TEXT NOT NULL,
      notified_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, scheduled_at, tier)
    )
  `).run();

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

// Strip a phone number down to the bare 10-digit form FracTEL expects.
function toDidFormat(value) {
  let cleaned = (value || '').toString().replace(/[^\d]/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

// The DIDs currently cleared for outbound sending, in rotation order.
function getFractelDidPool() {
  const settings = getSettings();
  return (settings.fractel_enabled_dids || '')
    .split(',')
    .map(toDidFormat)
    .filter(did => did.length === 10);
}

// Advance the round-robin cursor and hand back the next DID. The read and the
// write share one transaction so concurrent sends can't land on the same number.
const nextRotatingDid = db.transaction((pool) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'fractel_rotation_index'").get();
  const index = parseInt(row && row.value, 10) || 0;
  const did = pool[index % pool.length];
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('fractel_rotation_index', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String((index + 1) % 1000000));
  return did;
});

function setConversationDid(conversationId, did) {
  db.prepare('UPDATE conversations SET assigned_did = ? WHERE id = ?').run(did, conversationId);
}

/**
 * Decide which number a message to `conversationId` goes out from.
 *
 * Rotation is sticky per contact rather than per message: the first outbound
 * message claims the next DID in the pool and pins it to the conversation, and
 * every later message reuses it. A contact therefore always sees one sender,
 * while the pool spreads volume across all numbers.
 *
 * Passing an explicit number overrides rotation and re-pins the conversation.
 */
function resolveSenderNumber(conversationId, requested) {
  const settings = getSettings();
  const pool = getFractelDidPool();
  const requestedStr = (requested || '').toString().trim();
  const wantsRotation = !requestedStr || requestedStr.toLowerCase() === ROTATE_SENDER;

  if (!wantsRotation) {
    const explicit = toDidFormat(requestedStr);
    if (explicit.length === 10) {
      if (conversationId) setConversationDid(conversationId, explicit);
      return explicit;
    }
    // Not a US 10-digit number (e.g. the legacy BulkVS sender) - pass through.
    return requestedStr;
  }

  if (!pool.length) {
    return toDidFormat(settings.fractel_sender_number) || settings.sender_number || '';
  }

  if (conversationId) {
    const row = db.prepare('SELECT assigned_did FROM conversations WHERE id = ?').get(conversationId);
    const existing = row && row.assigned_did;
    // Only reuse a pinned DID that is still in the pool; a retired number
    // falls through to rotation instead of failing to send.
    if (existing && pool.includes(existing)) {
      return existing;
    }
  }

  const did = nextRotatingDid(pool);
  if (conversationId) setConversationDid(conversationId, did);
  return did;
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

function getOrCreateConversation(phoneNumber, contactName = null, city = null, zip = null) {
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  if (!cleanPhone) {
    throw new Error("Invalid phone number");
  }
  
  // Try to find
  let conv = db.prepare('SELECT * FROM conversations WHERE phone_number = ?').get(cleanPhone);
  if (!conv) {
    try {
      const result = db.prepare('INSERT INTO conversations (phone_number, name, city, zip) VALUES (?, ?, ?, ?)').run(cleanPhone, contactName, city, zip);
      conv = {
        id: result.lastInsertRowid,
        phone_number: cleanPhone,
        name: contactName,
        city: city,
        zip: zip,
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
    if (zip && conv.zip !== zip) {
      conv.zip = zip;
      updateFields.push("zip = ?");
      updateValues.push(zip);
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

    // Classify the reply and persist suppression. recordOptOut is idempotent
    // and first-wins, so a later message never overwrites an earlier opt-out,
    // and a later non-opt-out message never clears one.
    const replyClass = classification.classifyReply(msg.body);
    db.prepare('UPDATE conversations SET reply_classification = ? WHERE id = ?')
      .run(replyClass, msg.conversation_id);

    if (replyClass === classification.CLASSIFICATIONS.OPT_OUT) {
      recordOptOut(msg.conversation_id, { source: 'inbound_keyword', text: msg.body });
    } else if (replyClass === classification.CLASSIFICATIONS.WRONG_NUMBER) {
      recordWrongNumber(msg.conversation_id, { source: 'inbound_keyword', text: msg.body });
    }

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

/* ------------------------------------------------------------------
 * Reminder state
 *
 * Persisted so a reminder fires once per (conversation, scheduled time,
 * tier) and survives refreshes and restarts. Rescheduling clears the rows
 * for the old time, so a moved appointment can remind again.
 * ------------------------------------------------------------------ */
const REMINDER_TIERS = ['overdue', 'due_now', 'due_15', 'due_60'];

function getNotifiedReminders() {
  // Only rows still matching a live schedule matter; the rest are noise.
  return db.prepare(`
    SELECT r.conversation_id, r.scheduled_at, r.tier, r.notified_at
    FROM reminder_state r
    JOIN conversations c ON c.id = r.conversation_id AND c.scheduled_at = r.scheduled_at
  `).all();
}

function acknowledgeReminder(conversationId, scheduledAt, tier) {
  db.prepare(`
    INSERT OR IGNORE INTO reminder_state (conversation_id, scheduled_at, tier)
    VALUES (?, ?, ?)
  `).run(conversationId, scheduledAt, tier);
  console.log(`[reminder] delivered ${tier} for conversation ${conversationId} @ ${scheduledAt}Z`);
}

/**
 * Record a carrier delivery receipt. status='sent' only means the carrier
 * accepted the message; this is the only signal that it reached a handset.
 */
function recordDelivery(messageId, carrierStatus) {
  db.prepare(`
    UPDATE messages
    SET delivered_at = datetime('now'), carrier_status = ?
    WHERE id = ?
  `).run(carrierStatus || 'DELIVRD', messageId);
}

/** Record a non-delivery carrier status without claiming delivery. */
function recordCarrierStatus(messageId, carrierStatus) {
  db.prepare('UPDATE messages SET carrier_status = ? WHERE id = ?').run(carrierStatus, messageId);
}

// Queue functions
//
// A message can sit in the queue (or be future-scheduled) for a long time. If
// the contact opts out in the meantime, the queued message must NOT go out, so
// the queue re-checks suppression at dequeue time rather than trusting the
// check performed when the row was created.
function getNextQueuedMessage() {
  return db.prepare(`
    SELECT * FROM messages
    WHERE status = 'queued'
    AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get();
}

/**
 * Cancel a queued message whose contact became suppressed after it was queued.
 * Returns the block when the message was cancelled, or null when it may send.
 */
function cancelIfSuppressed(msg) {
  if (!msg || msg.direction !== 'outbound') return null;

  const block = getSuppressionBlock(msg.conversation_id, { scope: 'individual' });
  if (!block) return null;

  db.prepare(`
    UPDATE messages
    SET status = 'failed', error_message = ?
    WHERE id = ?
  `).run(`Blocked before send: ${block.label}`, msg.id);

  logSuppressionEvent(msg.conversation_id, msg.to_number, 'blocked_send', block.reason,
                      `queued message ${msg.id} cancelled at dequeue`, 'queue');
  console.warn(`[suppression] queued message ${msg.id} cancelled: ${block.label}`);
  return block;
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

/* ==================================================================
 * Contact suppression
 *
 * Suppression is PERSISTED STATE, never inferred from the latest reply.
 * A contact who texts STOP and then texts again next week is still
 * suppressed. The only way out is the explicit re-opt-in workflow.
 *
 * Two independent axes:
 *   - Legal/hard suppression: opted_out, wrong_number.
 *   - Business disposition:   no, unqualified, customer.
 * Both block bulk sending. Only the first blocks individual sending.
 * ================================================================== */

// Dispositions excluded from bulk sends. These are business decisions, not
// legal opt-outs, so a human may still message them one to one.
const BLOCKED_DISPOSITIONS = ['no', 'unqualified', 'customer'];

const SUPPRESSION_REASONS = {
  OPTED_OUT: 'opted_out',
  WRONG_NUMBER: 'wrong_number',
  DISPOSITION_NO: 'disposition_no',
  DISPOSITION_UNQUALIFIED: 'disposition_unqualified',
  DISPOSITION_CUSTOMER: 'disposition_customer',
  MISSING: 'missing_conversation'
};

const SUPPRESSION_LABELS = {
  opted_out: 'Opted out',
  wrong_number: 'Wrong number',
  disposition_no: 'Marked No',
  disposition_unqualified: 'Marked Unqualified',
  disposition_customer: 'Already a customer',
  missing_conversation: 'Conversation not found'
};

function logSuppressionEvent(conversationId, phoneNumber, event, reason, detail, actor) {
  try {
    db.prepare(`
      INSERT INTO suppression_events (conversation_id, phone_number, event, reason, detail, actor)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversationId || null, phoneNumber || null, event, reason || null,
           detail ? String(detail).slice(0, 500) : null, actor || null);
  } catch (err) {
    // The audit log must never break a send path.
    console.error('[suppression] failed to write audit event:', err.message);
  }
}

/**
 * Record a permanent opt-out. Idempotent: the FIRST opt-out wins so the audit
 * trail keeps the original message and timestamp.
 */
function recordOptOut(conversationId, { source = 'inbound_keyword', text = null, actor = null } = {}) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return null;
  if (conv.opted_out) return conv; // already suppressed - do not overwrite

  db.prepare(`
    UPDATE conversations
    SET opted_out = 1,
        opted_out_at = datetime('now'),
        opt_out_source = ?,
        opt_out_text = ?,
        suppression_reason = 'opted_out',
        opted_in_at = NULL,
        opted_in_by = NULL
    WHERE id = ?
  `).run(source, text ? String(text).slice(0, 500) : null, conversationId);

  logSuppressionEvent(conversationId, conv.phone_number, 'opt_out', source, text, actor);
  console.log(`[suppression] opt-out recorded for conversation ${conversationId} (source=${source})`);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

/** Flag a number as belonging to the wrong person. Idempotent. */
function recordWrongNumber(conversationId, { source = 'inbound_keyword', text = null, actor = null } = {}) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return null;
  if (conv.wrong_number) return conv;

  db.prepare(`
    UPDATE conversations
    SET wrong_number = 1,
        wrong_number_at = datetime('now'),
        suppression_reason = COALESCE(suppression_reason, 'wrong_number')
    WHERE id = ?
  `).run(conversationId);

  logSuppressionEvent(conversationId, conv.phone_number, 'wrong_number', source, text, actor);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

/**
 * Explicit re-opt-in. This is the ONLY thing that clears an opt-out, and it
 * requires a named actor. Nothing automatic ever calls this.
 */
function recordOptIn(conversationId, actor) {
  if (!actor) throw new Error('Re-opt-in requires an actor');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return null;

  db.prepare(`
    UPDATE conversations
    SET opted_out = 0,
        wrong_number = 0,
        opted_in_at = datetime('now'),
        opted_in_by = ?,
        suppression_reason = NULL
    WHERE id = ?
  `).run(String(actor).slice(0, 120), conversationId);

  logSuppressionEvent(conversationId, conv.phone_number, 'opt_in', 'manual',
                      `previous opt-out: ${conv.opt_out_text || 'n/a'}`, actor);
  console.log(`[suppression] re-opt-in for conversation ${conversationId} by ${actor}`);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

/**
 * THE single suppression gate. Every outbound path calls this.
 *
 * @param {object|number} conversation  conversation row or id
 * @param {object} options
 *        options.scope 'individual' blocks only hard suppression;
 *                      'bulk' (default) also blocks business dispositions.
 * @returns {null|{reason, label, hard}}  null when sending is allowed
 */
function getSuppressionBlock(conversation, { scope = 'bulk' } = {}) {
  const conv = typeof conversation === 'object' && conversation !== null
    ? conversation
    : db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation);

  if (!conv) {
    return { reason: SUPPRESSION_REASONS.MISSING, label: SUPPRESSION_LABELS.missing_conversation, hard: true };
  }

  // Hard suppression applies to every path, including one-to-one sends.
  if (conv.opted_out) {
    return { reason: SUPPRESSION_REASONS.OPTED_OUT, label: SUPPRESSION_LABELS.opted_out, hard: true };
  }
  if (conv.wrong_number) {
    return { reason: SUPPRESSION_REASONS.WRONG_NUMBER, label: SUPPRESSION_LABELS.wrong_number, hard: true };
  }

  if (scope === 'individual') return null;

  if (conv.disposition && BLOCKED_DISPOSITIONS.includes(conv.disposition)) {
    const reason = `disposition_${conv.disposition}`;
    return { reason, label: SUPPRESSION_LABELS[reason], hard: false };
  }

  return null;
}

/** Convenience wrapper used by the bulk paths. Returns a reason string or null. */
function getBulkSendBlockReason(conv) {
  const block = getSuppressionBlock(conv, { scope: 'bulk' });
  return block ? block.reason : null;
}

/**
 * Scan EVERY historical inbound message (not just the latest) and permanently
 * suppress contacts who ever sent explicit opt-out language.
 *
 * Idempotent: contacts already opted out are left untouched so the original
 * timestamp and message survive. A manual re-opt-in is also respected — if
 * someone was deliberately opted back in after the opt-out, we do not undo it.
 *
 * A plain "No" is NOT treated as a legal opt-out here; it is counted under
 * ambiguous so a human can decide.
 */
function backfillSuppression({ dryRun = false } = {}) {
  const summary = {
    conversations_scanned: 0,
    inbound_messages_scanned: 0,
    opt_outs_identified: 0,
    wrong_numbers_identified: 0,
    records_updated: 0,
    already_suppressed: 0,
    skipped_due_to_opt_in: 0,
    ambiguous_left_for_review: 0,
    dry_run: dryRun
  };

  const conversations = db.prepare('SELECT * FROM conversations').all();
  summary.conversations_scanned = conversations.length;

  const inboundStmt = db.prepare(`
    SELECT id, body, created_at FROM messages
    WHERE conversation_id = ? AND direction = 'inbound'
    ORDER BY created_at ASC, id ASC
  `);

  const apply = db.transaction(() => {
    for (const conv of conversations) {
      const inbound = inboundStmt.all(conv.id);
      summary.inbound_messages_scanned += inbound.length;

      let firstOptOut = null;
      let firstWrongNumber = null;
      let sawNegative = false;

      for (const msg of inbound) {
        const cls = classification.classifyReply(msg.body);
        if (cls === classification.CLASSIFICATIONS.OPT_OUT && !firstOptOut) {
          firstOptOut = msg;
        } else if (cls === classification.CLASSIFICATIONS.WRONG_NUMBER && !firstWrongNumber) {
          firstWrongNumber = msg;
        } else if (cls === classification.CLASSIFICATIONS.NEGATIVE) {
          sawNegative = true;
        }
      }

      if (firstOptOut) summary.opt_outs_identified++;
      if (firstWrongNumber) summary.wrong_numbers_identified++;
      if (!firstOptOut && !firstWrongNumber && sawNegative) summary.ambiguous_left_for_review++;

      // Someone was explicitly opted back in after their opt-out; respect that.
      if (conv.opted_in_at && conv.opted_in_by) {
        if (firstOptOut || firstWrongNumber) summary.skipped_due_to_opt_in++;
        continue;
      }

      if (conv.opted_out && firstOptOut) {
        summary.already_suppressed++;
        continue;
      }

      let updated = false;

      if (firstOptOut && !conv.opted_out) {
        if (!dryRun) {
          db.prepare(`
            UPDATE conversations
            SET opted_out = 1,
                opted_out_at = ?,
                opt_out_source = 'backfill',
                opt_out_text = ?,
                suppression_reason = 'opted_out'
            WHERE id = ?
          `).run(firstOptOut.created_at, String(firstOptOut.body || '').slice(0, 500), conv.id);
          logSuppressionEvent(conv.id, conv.phone_number, 'opt_out', 'backfill', firstOptOut.body, 'backfill');
        }
        updated = true;
      }

      if (firstWrongNumber && !conv.wrong_number) {
        if (!dryRun) {
          db.prepare(`
            UPDATE conversations
            SET wrong_number = 1,
                wrong_number_at = ?,
                suppression_reason = COALESCE(suppression_reason, 'wrong_number')
            WHERE id = ?
          `).run(firstWrongNumber.created_at, conv.id);
          logSuppressionEvent(conv.id, conv.phone_number, 'wrong_number', 'backfill', firstWrongNumber.body, 'backfill');
        }
        updated = true;
      }

      // Keep the display classification in step with the newest reply.
      if (!dryRun && inbound.length) {
        const latest = inbound[inbound.length - 1];
        db.prepare('UPDATE conversations SET reply_classification = ? WHERE id = ?')
          .run(classification.classifyReply(latest.body), conv.id);
      }

      if (updated) summary.records_updated++;
    }
  });

  apply();
  return summary;
}

function bulkImportLeads(leads, messageTemplate, fromNumber = null) {
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
  const skipped = [];
  const result = {
    total_submitted: 0,
    new_contacts: 0,
    existing_contacts: 0,
    contacts_updated: 0,
    invalid_rows: 0,
    duplicate_rows: 0,
    messages_queued: 0,
    skipped_suppressed: 0,
    skipped_opted_out: 0,
    skipped_wrong_number: 0,
    skipped_disposition: 0,
    errors: []
  };

  const existsStmt = db.prepare('SELECT id FROM conversations WHERE phone_number = ?');
  const seenPhones = new Set();

  const transaction = db.transaction((leadsList) => {
    for (const lead of leadsList) {
      result.total_submitted++;

      const normalized = normalizePhoneNumber(lead && lead.phone_number);
      if (!normalized || normalized.replace(/\D/g, '').length < 10) {
        result.invalid_rows++;
        continue;
      }
      if (seenPhones.has(normalized)) {
        result.duplicate_rows++;
        continue;
      }
      seenPhones.add(normalized);

      // Distinguish genuinely new contacts from ones we already had, BEFORE
      // the upsert. Previously every row counted as "imported", including
      // rows that were then skipped.
      const preexisting = existsStmt.get(normalized);

      let conv;
      try {
        conv = getOrCreateConversation(normalized, lead.name, lead.city, lead.zip);
      } catch (err) {
        result.invalid_rows++;
        result.errors.push({ phone_number: normalized, error: err.message });
        continue;
      }

      if (preexisting) {
        result.existing_contacts++;
      } else {
        result.new_contacts++;
      }

      // Re-importing must not resurrect someone who opted out or was closed.
      // Note this runs BEFORE the stage reset, so a suppressed contact keeps
      // whatever stage they already had.
      const blockReason = getBulkSendBlockReason(conv);
      if (blockReason) {
        skipped.push({ id: conv.id, phone_number: conv.phone_number, reason: blockReason });
        result.skipped_suppressed++;
        if (blockReason === 'opted_out') result.skipped_opted_out++;
        else if (blockReason === 'wrong_number') result.skipped_wrong_number++;
        else result.skipped_disposition++;
        logSuppressionEvent(conv.id, conv.phone_number, 'blocked_send', blockReason,
                            'csv import', 'import');
        continue;
      }

      result.contacts_updated++;

      // Reset stage to Stage 1 upon re-import/new import
      db.prepare("UPDATE conversations SET stage = 'Stage 1' WHERE id = ?").run(conv.id);

      if (messageTemplate) {
        // Replace placeholders
        let body = messageTemplate;
        const nameVal = lead.name || '';
        const cityVal = lead.city || '';
        const zipVal = lead.zip || '';
        body = body.replace(/\[Name\]/gi, nameVal);
        body = body.replace(/\[City\]/gi, cityVal);
        body = body.replace(/\[Zip(?:\s*Code)?\]/gi, zipVal);

        const fromNum = resolveSenderNumber(conv.id, fromNumber);

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
  result.messages_queued = insertedMessages.length;
  console.log('[import] summary:', JSON.stringify(result));
  return { ...result, messages: insertedMessages, skipped };
}

function sendBulkMessages(conversationIds, messageTemplate, fromNumber = null) {
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
      const zipVal = conv.zip || '';
      body = body.replace(/\[Name\]/gi, nameVal);
      body = body.replace(/\[City\]/gi, cityVal);
      body = body.replace(/\[Zip(?:\s*Code)?\]/gi, zipVal);

      const fromNum = resolveSenderNumber(conv.id, fromNumber);

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

/**
 * Set or clear the business disposition.
 *
 * This NEVER touches opted_out / wrong_number. Clearing a disposition returns
 * the lead to New for triage but leaves any legal suppression intact — undoing
 * a "No" must not resurrect someone who texted STOP.
 */
function setConversationDisposition(id, disposition, scheduledAt = null, note = null, actor = null) {
  if (disposition !== null && !VALID_DISPOSITIONS.includes(disposition)) {
    throw new Error(`Invalid disposition: ${disposition}`);
  }
  if ((disposition === 'appointment' || disposition === 'follow_up') && !scheduledAt) {
    throw new Error(`A date and time is required for the '${disposition}' disposition`);
  }

  const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!existing) return undefined;

  // Only the scheduled dispositions keep a date on the record
  const keepsSchedule = disposition === 'appointment' || disposition === 'follow_up';
  const nextSchedule = keepsSchedule ? scheduledAt : null;

  db.prepare(`
    UPDATE conversations
    SET disposition = ?,
        disposition_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
        scheduled_at = ?,
        disposition_note = ?
    WHERE id = ?
  `).run(disposition, disposition, nextSchedule, note || null, id);

  // Rescheduling or clearing invalidates any reminders already fired.
  if (existing.scheduled_at && existing.scheduled_at !== nextSchedule) {
    db.prepare('DELETE FROM reminder_state WHERE conversation_id = ? AND scheduled_at = ?')
      .run(id, existing.scheduled_at);
  }

  console.log(`[disposition] conversation ${id}: ${existing.disposition || 'none'} -> ${disposition || 'none'}` +
              `${nextSchedule ? ` @ ${nextSchedule}Z` : ''}${actor ? ` by ${actor}` : ''}`);

  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

/** Exclusive upper bound: midnight UTC at the start of the following day. */
function nextUtcDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Performance stats for a date range (inclusive, YYYY-MM-DD).
 *
 * TERMINOLOGY — these names match what the carrier data actually supports,
 * and the UI must not rename them:
 *
 *   attempted        outbound rows created in the window
 *   carrier_accepted status='sent' — the carrier took the message. This is
 *                    NOT proof of handset delivery.
 *   delivered        a carrier delivery receipt confirmed handset delivery
 *                    (delivered_at set). Only DLR-capable routes report this.
 *   failed           carrier rejected, or a DLR reported UNDELIV/REJECTD/EXPIRED
 *   queued           still waiting in the send queue
 *   unknown_delivery carrier-accepted but no DLR ever arrived
 *
 * Every rate documents its denominator in `rate_definitions`.
 */
function getStats(fromDate, toDate, options = {}) {
  // Timestamps are stored UTC, but the user picks dates in THEIR timezone.
  // Filtering on date(created_at) therefore attributed anything sent after
  // local midnight-minus-offset to the wrong day - for a US user that is
  // every message after ~8pm. The client sends the exact UTC instants that
  // bound its local day range; when absent we fall back to UTC day bounds.
  const startUtc = options.startUtc || `${fromDate} 00:00:00`;
  const endUtc = options.endUtc || nextUtcDay(toDate);
  // Minutes to add to a UTC timestamp to get the viewer's local time.
  const tzShift = `${Number(options.tzOffsetMinutes) || 0} minutes`;
  const range = [startUtc, endUtc];

  const outbound = db.prepare(`
    SELECT
      COUNT(*) as attempted,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as carrier_accepted,
      SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status IN ('queued', 'sending') THEN 1 ELSE 0 END) as queued,
      COUNT(DISTINCT conversation_id) as contacts_reached
    FROM messages
    WHERE direction = 'outbound' AND created_at >= ? AND created_at < ?
  `).get(...range);

  // Contacts actually handed to a carrier: the only defensible denominator for
  // a reply rate. Someone whose message is still queued has had no chance to reply.
  const contactsAccepted = db.prepare(`
    SELECT COUNT(DISTINCT conversation_id) as c
    FROM messages
    WHERE direction = 'outbound' AND status = 'sent' AND created_at >= ? AND created_at < ?
  `).get(...range).c || 0;

  // Inbound replies, classified through the single canonical module.
  const inboundRows = db.prepare(`
    SELECT conversation_id, body
    FROM messages
    WHERE direction = 'inbound' AND created_at >= ? AND created_at < ?
  `).all(...range);

  const messageCounts = { positive: 0, negative: 0, opt_out: 0, wrong_number: 0, unknown: 0 };
  const responders = new Set();
  // Each contact counted once, under their strongest signal, so one chatty
  // lead cannot inflate the positive count.
  const contactBest = new Map();
  const RANK = { opt_out: 4, wrong_number: 3, negative: 2, positive: 1, unknown: 0 };

  inboundRows.forEach(row => {
    responders.add(row.conversation_id);
    const cls = classification.classifyReply(row.body);
    messageCounts[cls]++;
    const current = contactBest.get(row.conversation_id);
    if (!current || RANK[cls] > RANK[current]) {
      contactBest.set(row.conversation_id, cls);
    }
  });

  const uniqueCounts = { positive: 0, negative: 0, opt_out: 0, wrong_number: 0, unknown: 0 };
  contactBest.forEach(cls => { uniqueCounts[cls]++; });

  const daily = db.prepare(`
    SELECT
      date(created_at, ?) as day,
      SUM(CASE WHEN direction = 'outbound' AND status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN direction = 'outbound' AND status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as replies
    FROM messages
    WHERE created_at >= ? AND created_at < ?
    GROUP BY date(created_at, ?)
    ORDER BY day ASC
  `).all(tzShift, ...range, tzShift);

  const dispositionRows = db.prepare(`
    SELECT disposition, COUNT(*) as count
    FROM conversations
    WHERE disposition IS NOT NULL AND disposition_at >= ? AND disposition_at < ?
    GROUP BY disposition
  `).all(...range);

  const dispositions = { appointment: 0, follow_up: 0, no: 0, unqualified: 0, customer: 0 };
  dispositionRows.forEach(row => {
    if (row.disposition in dispositions) dispositions[row.disposition] = row.count;
  });

  const newLeads = db.prepare(`
    SELECT COUNT(*) as count FROM conversations WHERE created_at >= ? AND created_at < ?
  `).get(...range).count;

  const suppression = db.prepare(`
    SELECT
      SUM(CASE WHEN opted_out_at >= ? AND opted_out_at < ? THEN 1 ELSE 0 END) as opt_outs,
      SUM(CASE WHEN wrong_number_at >= ? AND wrong_number_at < ? THEN 1 ELSE 0 END) as wrong_numbers
    FROM conversations
  `).get(startUtc, endUtc, startUtc, endUtc);

  // Minutes between our last outbound and their reply. Negative gaps are
  // impossible by construction, but the guard stops a clock change from
  // poisoning the average.
  const replyLag = db.prepare(`
    SELECT AVG(gap) as avg_minutes FROM (
      SELECT (julianday(m.created_at) - julianday((
        SELECT MAX(o.created_at) FROM messages o
        WHERE o.conversation_id = m.conversation_id
          AND o.direction = 'outbound'
          AND o.created_at < m.created_at
      ))) * 1440 as gap
      FROM messages m
      WHERE m.direction = 'inbound' AND m.created_at >= ? AND m.created_at < ?
    ) WHERE gap IS NOT NULL AND gap >= 0
  `).get(...range).avg_minutes;

  const peakHour = db.prepare(`
    SELECT strftime('%H', created_at, ?) as hour, COUNT(*) as count
    FROM messages
    WHERE direction = 'inbound' AND created_at >= ? AND created_at < ?
    GROUP BY hour
    ORDER BY count DESC, hour ASC
    LIMIT 1
  `).get(tzShift, ...range);

  const attempted = outbound.attempted || 0;
  const carrierAccepted = outbound.carrier_accepted || 0;
  const delivered = outbound.delivered || 0;
  const failed = outbound.failed || 0;

  const rate = (numerator, denominator) =>
    denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

  return {
    from: fromDate,
    to: toDate,
    sent: {
      attempted,
      carrier_accepted: carrierAccepted,
      delivered,
      unknown_delivery: Math.max(0, carrierAccepted - delivered),
      failed,
      queued: outbound.queued || 0,
      contacts_reached: outbound.contacts_reached || 0,
      contacts_accepted: contactsAccepted,
      acceptance_rate: rate(carrierAccepted, carrierAccepted + failed),
      confirmed_delivery_rate: rate(delivered, carrierAccepted)
    },
    responses: {
      total_messages: inboundRows.length,
      unique_responders: responders.size,
      positive_messages: messageCounts.positive,
      negative_messages: messageCounts.negative,
      opt_out_messages: messageCounts.opt_out,
      wrong_number_messages: messageCounts.wrong_number,
      unknown_messages: messageCounts.unknown,
      positive_contacts: uniqueCounts.positive,
      negative_contacts: uniqueCounts.negative,
      opt_out_contacts: uniqueCounts.opt_out,
      wrong_number_contacts: uniqueCounts.wrong_number,
      unknown_contacts: uniqueCounts.unknown,
      response_rate: rate(responders.size, contactsAccepted),
      positive_rate_of_responders: rate(uniqueCounts.positive, responders.size),
      positive_rate_of_contacted: rate(uniqueCounts.positive, contactsAccepted),
      negative_rate_of_responders: rate(uniqueCounts.negative, responders.size),
      opt_out_rate_of_contacted: rate(uniqueCounts.opt_out, contactsAccepted)
    },
    suppression: {
      opt_outs_recorded: suppression.opt_outs || 0,
      wrong_numbers_recorded: suppression.wrong_numbers || 0
    },
    dispositions,
    new_leads: newLeads,
    avg_reply_minutes: replyLag === null || replyLag === undefined ? null : Math.round(replyLag),
    peak_reply_hour: peakHour ? parseInt(peakHour.hour, 10) : null,
    daily,
    // Rendered as tooltips so no metric on screen is ambiguous.
    rate_definitions: {
      acceptance_rate: 'Carrier-accepted / (carrier-accepted + failed) messages',
      confirmed_delivery_rate: 'Messages with a carrier delivery receipt / carrier-accepted messages',
      response_rate: 'Unique contacts who replied / unique contacts whose message the carrier accepted',
      positive_rate_of_responders: 'Contacts whose strongest reply was positive / unique contacts who replied',
      positive_rate_of_contacted: 'Contacts whose strongest reply was positive / unique contacts whose message the carrier accepted',
      negative_rate_of_responders: 'Contacts whose strongest reply was negative / unique contacts who replied',
      opt_out_rate_of_contacted: 'Contacts who opted out / unique contacts whose message the carrier accepted'
    }
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

function getNotesForConversation(conversationId) {
  return db.prepare(`
    SELECT * FROM notes 
    WHERE conversation_id = ? 
    ORDER BY created_at DESC, id DESC
  `).all(conversationId);
}

function addNoteForConversation(conversationId, noteText, phoneNumber = null) {
  const stmt = db.prepare(`
    INSERT INTO notes (conversation_id, phone_number, note_text, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `);
  const result = stmt.run(conversationId, phoneNumber, noteText ? noteText.trim() : '');
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
}

function deleteNote(noteId) {
  return db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
}

module.exports = {
  db,
  initDatabase,
  getSettings,
  updateSettings,
  getConversations,
  getOrCreateConversation,
  getFractelDidPool,
  resolveSenderNumber,
  setConversationDid,
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
  classifyReply: classification.classifyReply,
  CLASSIFICATIONS: classification.CLASSIFICATIONS,
  getBulkSendBlockReason,
  getSuppressionBlock,
  recordOptOut,
  recordWrongNumber,
  recordOptIn,
  logSuppressionEvent,
  backfillSuppression,
  cancelIfSuppressed,
  recordDelivery,
  recordCarrierStatus,
  getNotifiedReminders,
  acknowledgeReminder,
  REMINDER_TIERS,
  SUPPRESSION_REASONS,
  SUPPRESSION_LABELS,
  getStats,
  countUsers,
  createUser,
  validateUser,
  createSession,
  validateSession,
  deleteSession
};

