const db = require('./database');
const EventEmitter = require('events');

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
      const username = settings.bulkvs_username || '';
      const token = settings.bulkvs_token || '';
      const senderNumber = settings.sender_number || '';
      const sendInterval = parseInt(settings.send_interval_ms, 10) || 2000;

      // Construct auth header
      const auth = Buffer.from(`${username}:${token}`).toString('base64');
      const authHeader = `Basic ${auth}`;

      // Normalize numbers for Bulkvs: strip "+" and non-digits
      const fromNum = senderNumber.replace(/[^\d]/g, '');
      const toNum = msg.to_number.replace(/[^\d]/g, '');

      console.log(`Sending message ID ${msg.id} to ${toNum}...`);

      const payload = {
        From: fromNum,
        To: [toNum],
        Message: msg.body
      };

      // If there are media URLs, include them to send MMS
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

      if (response.ok && data.Results && data.Results[0] && data.Results[0].Status === 'SUCCESS') {
        const refId = data.RefId || '';
        db.updateMessageStatus(msg.id, 'sent', refId);
        this.emit('messageStatusChanged', { 
          id: msg.id, 
          status: 'sent', 
          ref_id: refId, 
          conversation_id: msg.conversation_id 
        });
      } else {
        const errorMsg = (data.Results && data.Results[0] && data.Results[0].Error) || data.message || 'API error';
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
