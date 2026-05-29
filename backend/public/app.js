// Application State
let activeConversation = null;
let conversations = [];
let messages = [];
let ws = null;
let wsReconnectTimer = null;

// DOM Elements
const conversationsList = document.getElementById('conversations-list');
const searchInput = document.getElementById('search-input');
const chatHeader = document.getElementById('chat-header');
const activeAvatar = document.getElementById('active-avatar');
const activeContactName = document.getElementById('active-contact-name');
const activeContactPhone = document.getElementById('active-contact-phone');
const messagesFeed = document.getElementById('messages-feed');
const chatComposerContainer = document.getElementById('chat-composer-container');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const mediaUrlInput = document.getElementById('media-url-input');
const wsStatus = document.getElementById('ws-status');

// Settings Elements
const settingsForm = document.getElementById('settings-form');
const settingSender = document.getElementById('setting-sender');
const settingInterval = document.getElementById('setting-interval');
const settingIntervalVal = document.getElementById('setting-interval-val');
const settingUsername = document.getElementById('setting-username');
const settingToken = document.getElementById('setting-token');
const settingsStatus = document.getElementById('settings-status');
const webhookUrlDisplay = document.getElementById('webhook-url-display');
const btnCopyWebhook = document.getElementById('btn-copy-webhook');

// Stats Elements
const statQueued = document.getElementById('stat-queued');
const statSending = document.getElementById('stat-sending');
const statSent = document.getElementById('stat-sent');
const statFailed = document.getElementById('stat-failed');

// Modal Elements
const btnNewChat = document.getElementById('btn-new-chat');
const newChatModal = document.getElementById('new-chat-modal');
const modalClose = document.getElementById('modal-close');
const newChatForm = document.getElementById('new-chat-form');
const newPhoneInput = document.getElementById('new-phone');
const newNameInput = document.getElementById('new-name');

// 1. Initial Load & Setup
window.addEventListener('DOMContentLoaded', () => {
  loadConversations();
  loadSettings();
  setupWebSockets();
  
  // Set webhook URL based on current host
  const host = window.location.host;
  const protocol = window.location.protocol;
  webhookUrlDisplay.textContent = `${protocol}//${host}/webhook/inbound`;

  // Event Listeners
  searchInput.addEventListener('input', filterConversations);
  chatForm.addEventListener('submit', handleSendMessage);
  btnNewChat.addEventListener('click', () => newChatModal.classList.add('open'));
  modalClose.addEventListener('click', () => newChatModal.classList.remove('open'));
  newChatForm.addEventListener('submit', handleStartNewChat);
  
  // Close modal when clicking outside content
  newChatModal.addEventListener('click', (e) => {
    if (e.target === newChatModal) newChatModal.classList.remove('remove');
  });

  // Range slider label sync
  settingInterval.addEventListener('input', (e) => {
    settingIntervalVal.textContent = `${e.target.value} ms`;
  });

  // Settings Save
  settingsForm.addEventListener('submit', handleSaveSettings);

  // Copy webhook URL
  btnCopyWebhook.addEventListener('click', () => {
    navigator.clipboard.writeText(webhookUrlDisplay.textContent).then(() => {
      btnCopyWebhook.textContent = '✅';
      setTimeout(() => btnCopyWebhook.textContent = '📋', 2000);
    });
  });

  // Textarea auto-resize
  messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight - 6) + 'px';
  });
});

// 2. Load API Data
async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    conversations = await res.json();
    renderConversations();
  } catch (err) {
    console.error("Error loading conversations:", err);
    conversationsList.innerHTML = `<div class="list-placeholder error">Failed to load chats</div>`;
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    
    settingSender.value = settings.sender_number || '+18887885527';
    settingInterval.value = settings.send_interval_ms || 2000;
    settingIntervalVal.textContent = `${settingInterval.value} ms`;
    settingUsername.value = settings.bulkvs_username || '';
    settingToken.value = settings.bulkvs_token || '';
  } catch (err) {
    console.error("Error loading settings:", err);
  }
}

// 3. WebSockets Connection
function setupWebSockets() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  wsStatus.textContent = 'WS Connecting';
  wsStatus.className = 'status-indicator offline';

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("WebSocket connected.");
    wsStatus.textContent = 'Gateway Live';
    wsStatus.className = 'status-indicator online';
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    handleWsMessage(payload);
  };

  ws.onclose = () => {
    console.warn("WebSocket closed. Attempting reconnect in 3s...");
    wsStatus.textContent = 'WS Disconnected';
    wsStatus.className = 'status-indicator offline';
    
    // Attempt reconnect
    if (!wsReconnectTimer) {
      wsReconnectTimer = setTimeout(setupWebSockets, 3000);
    }
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
}

// 4. WebSocket Message Routing
function handleWsMessage(payload) {
  const { type, data } = payload;
  
  switch(type) {
    case 'queue_status':
      updateQueueStatsUI(data);
      break;
    case 'message_new':
      handleIncomingNewMessage(data);
      break;
    case 'message_status':
      handleIncomingMessageStatusUpdate(data);
      break;
  }
}

// Update Stats Cards
function updateQueueStatsUI(stats) {
  statQueued.textContent = stats.queued;
  statSending.textContent = stats.sending;
  statSent.textContent = stats.sent;
  statFailed.textContent = stats.failed;

  // Add glowing animation to sending if count > 0
  if (stats.sending > 0) {
    statSending.classList.add('animate-pulse');
  } else {
    statSending.classList.remove('animate-pulse');
  }
}

// Handle Inbound or New Outbound message websocket push
function handleIncomingNewMessage(msg) {
  // If message belongs to active chat, render it
  if (activeConversation && msg.conversation_id === activeConversation.id) {
    messages.push(msg);
    appendMessageToFeed(msg);
    scrollToBottom();
  }
  
  // Reload conversation list to show correct preview
  loadConversations();
}

// Handle message status transition (queued -> sending -> sent/failed)
function handleIncomingMessageStatusUpdate(update) {
  // Update local message array if in active chat
  if (activeConversation && update.conversation_id === activeConversation.id) {
    const msgElement = document.querySelector(`[data-msg-id="${update.id}"]`);
    if (msgElement) {
      const badge = msgElement.querySelector('.status-badge');
      if (badge) {
        badge.textContent = update.status;
        badge.className = `status-badge ${update.status}`;
        if (update.status === 'failed' && update.error_message) {
          badge.title = update.error_message;
        } else if (update.status === 'sent' && update.ref_id) {
          badge.title = `Ref ID: ${update.ref_id}`;
        }
      }
      
      const meta = msgElement.querySelector('.message-meta');
      if (meta && update.status === 'sent') {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // update text content
        const timeNode = meta.firstChild;
        if (timeNode) timeNode.textContent = timeStr + ' ';
      }
    }
  }
  
  // Reload conversations side bar preview
  loadConversations();
}

// 5. Render Sidebar conversations
function renderConversations() {
  const query = searchInput.value.toLowerCase().trim();
  
  if (conversations.length === 0) {
    conversationsList.innerHTML = `<div class="list-placeholder">No conversations started</div>`;
    return;
  }

  conversationsList.innerHTML = '';
  
  const filtered = conversations.filter(c => {
    const name = (c.name || '').toLowerCase();
    const phone = c.phone_number.toLowerCase();
    return name.includes(query) || phone.includes(query);
  });

  if (filtered.length === 0) {
    conversationsList.innerHTML = `<div class="list-placeholder">No matches found</div>`;
    return;
  }

  filtered.forEach(c => {
    const isActive = activeConversation && activeConversation.id === c.id;
    const item = document.createElement('div');
    item.className = `conversation-item ${isActive ? 'active' : ''}`;
    item.dataset.id = c.id;
    
    const initials = c.name ? c.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase() : '#';
    const displayName = c.name || c.phone_number;
    
    // Format timestamp
    let timeStr = '';
    if (c.last_message_at) {
      const date = new Date(c.last_message_at);
      timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    const preview = c.last_message_text || 'No messages';

    item.innerHTML = `
      <div class="avatar">${initials}</div>
      <div class="conv-details">
        <div class="conv-meta">
          <span class="conv-name">${displayName}</span>
          <span class="conv-time">${timeStr}</span>
        </div>
        <div class="conv-preview">${preview}</div>
      </div>
    `;

    item.addEventListener('click', () => selectConversation(c));
    conversationsList.appendChild(item);
  });
}

function filterConversations() {
  renderConversations();
}

// 6. Select active chat
async function selectConversation(conv) {
  activeConversation = conv;
  
  // UI Selection styling
  document.querySelectorAll('.conversation-item').forEach(el => {
    el.classList.remove('active');
    if (parseInt(el.dataset.id) === conv.id) {
      el.classList.add('active');
    }
  });

  // Setup Chat Header
  const initials = conv.name ? conv.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase() : '#';
  activeAvatar.textContent = initials;
  activeContactName.textContent = conv.name || conv.phone_number;
  activeContactPhone.textContent = conv.name ? conv.phone_number : 'SMS Contact';
  
  // Show input field
  chatComposerContainer.style.display = 'block';
  
  // Load messages
  messagesFeed.innerHTML = `<div class="feed-placeholder">Loading message history...</div>`;
  
  try {
    const res = await fetch(`/api/conversations/${conv.id}/messages`);
    messages = await res.json();
    renderMessages();
  } catch (err) {
    console.error("Error fetching messages:", err);
    messagesFeed.innerHTML = `<div class="feed-placeholder error">Failed to load chat history.</div>`;
  }
}

// 7. Render messages
function renderMessages() {
  if (messages.length === 0) {
    messagesFeed.innerHTML = `
      <div class="feed-placeholder">
        <div class="welcome-box" style="box-shadow: none; border-color: transparent;">
          <p>No messages in this chat yet. Type a message below to start texting.</p>
        </div>
      </div>`;
    return;
  }

  messagesFeed.innerHTML = '';
  messages.forEach(msg => appendMessageToFeed(msg));
  scrollToBottom();
}

function appendMessageToFeed(msg) {
  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${msg.direction}`;
  bubble.dataset.msgId = msg.id;

  // Format time
  const date = new Date(msg.created_at || msg.sent_at || Date.now());
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Attachments
  let attachmentHtml = '';
  if (msg.media_urls) {
    try {
      const urls = JSON.parse(msg.media_urls);
      if (Array.isArray(urls) && urls.length > 0) {
        attachmentHtml = `<div class="message-attachments">`;
        urls.forEach(url => {
          if (url) {
            attachmentHtml += `<img src="${url}" class="mms-image" alt="Attachment" onerror="this.style.display='none'">`;
          }
        });
        attachmentHtml += `</div>`;
      }
    } catch(e) {}
  }

  // Outbound Status badge
  let badgeHtml = '';
  if (msg.direction === 'outbound') {
    let tooltip = '';
    if (msg.status === 'failed' && msg.error_message) tooltip = ` title="${msg.error_message}"`;
    if (msg.status === 'sent' && msg.ref_id) tooltip = ` title="Ref ID: ${msg.ref_id}"`;
    badgeHtml = `<span class="status-badge ${msg.status}"${tooltip}>${msg.status}</span>`;
  }

  bubble.innerHTML = `
    ${attachmentHtml}
    <div class="message-content">${escapeHTML(msg.body)}</div>
    <div class="message-meta">
      <span>${timeStr}</span>
      ${badgeHtml}
    </div>
  `;

  messagesFeed.appendChild(bubble);
}

function scrollToBottom() {
  messagesFeed.scrollTop = messagesFeed.scrollHeight;
}

// 8. Send SMS Message (Queue to Outbound)
async function handleSendMessage(e) {
  e.preventDefault();
  if (!activeConversation) return;

  const body = messageInput.value.trim();
  const mediaUrl = mediaUrlInput.value.trim();
  
  if (!body && !mediaUrl) return;

  // Disable button
  const btnSend = document.getElementById('btn-send');
  btnSend.disabled = true;

  const payload = {
    body: body,
    media_urls: mediaUrl ? [mediaUrl] : null
  };

  try {
    const res = await fetch(`/api/conversations/${activeConversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (res.ok) {
      // Clear inputs
      messageInput.value = '';
      messageInput.style.height = 'auto';
      mediaUrlInput.value = '';
    } else {
      const err = await res.json();
      alert("Error queueing message: " + err.error);
    }
  } catch (err) {
    console.error("Failed to send message:", err);
    alert("Connection error sending message.");
  } finally {
    btnSend.disabled = false;
  }
}

// 9. Start New Chat Modal Submit
async function handleStartNewChat(e) {
  e.preventDefault();
  
  const phone = newPhoneInput.value.trim();
  const name = newNameInput.value.trim();
  
  if (!phone) return;

  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: phone, name: name || null })
    });

    if (res.ok) {
      const newConv = await res.json();
      newChatModal.classList.remove('open');
      newPhoneInput.value = '';
      newNameInput.value = '';
      
      // Select the new chat
      await loadConversations();
      selectConversation(newConv);
    } else {
      const err = await res.json();
      alert("Error starting chat: " + err.error);
    }
  } catch (err) {
    console.error("Error creating chat:", err);
    alert("Failed to connect to server.");
  }
}

// 10. Save Settings Form Submit
async function handleSaveSettings(e) {
  e.preventDefault();
  
  settingsStatus.textContent = 'Saving...';
  settingsStatus.className = 'settings-status';

  const payload = {
    sender_number: settingSender.value.trim(),
    send_interval_ms: settingInterval.value,
    bulkvs_username: settingUsername.value.trim(),
    bulkvs_token: settingToken.value.trim()
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      settingsStatus.textContent = 'Settings saved successfully!';
      settingsStatus.className = 'settings-status success';
      setTimeout(() => { settingsStatus.textContent = ''; }, 3000);
    } else {
      settingsStatus.textContent = 'Error saving settings';
      settingsStatus.className = 'settings-status error';
    }
  } catch (err) {
    console.error("Save settings error:", err);
    settingsStatus.textContent = 'Connection error saving settings';
    settingsStatus.className = 'settings-status error';
  }
}

// Escaping HTML utility
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
