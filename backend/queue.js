const db = require('./database');
const EventEmitter = require('events');

let fractelToken = null;
let fractelTokenExpiresAt = 0;

async function getFractelToken(settings) {
  const username = settings.fractel_username || '';
  const password = settings.fractel_password || '';

  if (!username || !password) {
    throw new Error('FracTEL username or password is not configured.');
  }

  const now = Date.now();
  if (fractelToken && fractelTokenExpiresAt > now + 300000) {
    return fractelToken;
  }

  console.log('Fetching new FracTEL auth token...');
  const response = await fetch('https://api.fonestorm.com/v2/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: username,
      password: password,
      expires: 86400
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FracTEL auth failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const token = data.auth && data.auth.token;
  if (!token) {
    throw new Error('No auth token returned in FracTEL response.');
  }

  fractelToken = token;
  fractelTokenExpiresAt = now + (86400 - 1800) * 1000;
  console.log('Successfully retrieved and cached FracTEL token.');
  return fractelToken;
}

class QueueWorker extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.timer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("SMS Queue worker started.");
    this.processNext();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log("SMS Queue worker stopped.");
  }

  async processNext() {
    if (!this.isRunning) return;

    try {
      const msg = db.getNextQueuedMessage();
      if (!msg) {
        // No messages in queue, check again in 1 second
        this.timer = setTimeout(() => this.processNext(), 1000);
        return;
      }

      // Mark message as sending
      db.updateMessageStatus(msg.id, 'sending');
      this.emit('messageStatusChanged', { id: msg.id, status: 'sending', conversation_id: msg.conversation_id });

      // Get latest settings
      const settings = db.getSettings();
      const sendInterval = parseInt(settings.send_interval_ms, 10) || 2000;

      // Normalize phone numbers for routing decision
      let cleanFrom = (msg.from_number || '').replace(/[^\d]/g, '');
      if (cleanFrom.length === 11 && cleanFrom.startsWith('1')) {
        cleanFrom = cleanFrom.substring(1);
      }
      
      const fractelDidsStr = settings.fractel_enabled_dids || '';
      const fractelDids = fractelDidsStr.split(',').map(d => {
        let cd = d.trim().replace(/[^\d]/g, '');
        if (cd.length === 11 && cd.startsWith('1')) {
          cd = cd.substring(1);
        }
        return cd;
      }).filter(Boolean);

      const isFractel = fractelDids.includes(cleanFrom) || 
                       (cleanFrom === (settings.fractel_sender_number || '').replace(/[^\d]/g, '').replace(/^1/, ''));

      let isSuccess = false;
      let refId = '';
      let errorMsg = '';

      if (isFractel) {
        // --- ROUTE VIA FRACTEL (FONESTORM) ---
        console.log(`Routing message ID ${msg.id} via FracTEL...`);
        try {
          const token = await getFractelToken(settings);
          const toNum = msg.to_number.replace(/[^\d]/g, '');
          
          const payload = {
            fonenumber: cleanFrom,
            to: [toNum],
            message: msg.body
          };

          // If there are media URLs, include them for MMS
          if (msg.media_urls) {
            try {
              const urls = JSON.parse(msg.media_urls);
              if (urls && urls.length > 0) {
                payload.media = urls[0]; // FoneStorm takes a single string URL for media
              }
            } catch (e) {
              console.error("Failed to parse media URLs JSON:", e);
            }
          }

          const response = await fetch('https://api.fonestorm.com/v2/messages/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'token': token
            },
            body: JSON.stringify(payload)
          });

          const data = await response.json();
          console.log("FracTEL API response:", JSON.stringify(data));

          if (response.ok && data.message && data.message.id) {
            isSuccess = true;
            refId = data.message.id;
          } else {
            errorMsg = (data.error && data.error.message) || data.message || `API Error ${response.status}`;
          }
        } catch (err) {
          console.error("FracTEL sending failed:", err);
          errorMsg = err.message || "Failed to connect to FracTEL API";
        }
      } else {
        // --- ROUTE VIA BULKVS (DEFAULT) ---
        console.log(`Routing message ID ${msg.id} via BulkVS...`);
        try {
          const username = settings.bulkvs_username || '';
          const token = settings.bulkvs_token || '';
          const auth = Buffer.from(`${username}:${token}`).toString('base64');
          const authHeader = `Basic ${auth}`;

          const fromNum = cleanFrom || (settings.sender_number || '').replace(/[^\d]/g, '');
          const toNum = msg.to_number.replace(/[^\d]/g, '');

          const payload = {
            From: fromNum,
            To: [toNum],
            Message: msg.body
          };

          if (msg.media_urls) {
            try {
              payload.MediaURLs = JSON.parse(msg.media_urls);
            } catch (e) {
              console.error("Failed to parse media URLs JSON:", e);
            }
          }

          const response = await fetch('https://portal.bulkvs.com/api/v1.0/messageSend', {
            method: 'POST',
            headers: {
              'accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': authHeader
            },
            body: JSON.stringify(payload)
          });

          const data = await response.json();
          console.log("Bulkvs API response:", JSON.stringify(data));

          isSuccess = response.ok && (
            (data.Results && data.Results[0] && data.Results[0].Status === 'SUCCESS') ||
            (data.RefId && !data.error && !data.message)
          );

          if (isSuccess) {
            refId = data.RefId || '';
          } else {
            errorMsg = (data.Results && data.Results[0] && data.Results[0].Error) || data.message || 'API error';
          }
        } catch (err) {
          console.error("BulkVS sending failed:", err);
          errorMsg = err.message || "Failed to connect to BulkVS API";
        }
      }

      // Update message status based on success/failure
      if (isSuccess) {
        db.updateMessageStatus(msg.id, 'sent', refId);
        this.emit('messageStatusChanged', { 
          id: msg.id, 
          status: 'sent', 
          ref_id: refId, 
          conversation_id: msg.conversation_id 
        });
      } else {
        db.updateMessageStatus(msg.id, 'failed', null, errorMsg);
        this.emit('messageStatusChanged', { 
          id: msg.id, 
          status: 'failed', 
          error_message: errorMsg, 
          conversation_id: msg.conversation_id 
        });
      }

      // Schedule next check based on configured rate limit
      this.timer = setTimeout(() => this.processNext(), sendInterval);

    } catch (err) {
      console.error("Queue worker error processing message:", err);
      // Wait 5 seconds on system error before retrying
      this.timer = setTimeout(() => this.processNext(), 5000);
    }
  }
}

const worker = new QueueWorker();
module.exports = worker;
