// Application State
let activeConversation = null;
let conversations = [];
let messages = [];
let ws = null;
let wsReconnectTimer = null;
let parsedLeads = []; // Phase 2: Parsed leads storage
let currentFilter = 'replied'; // Phase 6: Default view is 'replied'
let fromDate = '';
let toDate = '';

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
const btnDeleteChat = document.getElementById('btn-delete-chat');

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

// FracTEL settings elements
const settingFractelSender = document.getElementById('setting-fractel-sender');
const settingFractelBrand = document.getElementById('setting-fractel-brand');
const settingFractelUsername = document.getElementById('setting-fractel-username');
const settingFractelPassword = document.getElementById('setting-fractel-password');
const composerSenderSelect = document.getElementById('composer-sender-select');
const campaignSenderSelect = document.getElementById('campaign-sender-select');

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

// Phase 2: Lead Upload DOM Elements
const btnUploadLeads = document.getElementById('btn-upload-leads');
const uploadLeadsModal = document.getElementById('upload-leads-modal');
const uploadClose = document.getElementById('upload-close');
const uploadLeadsForm = document.getElementById('upload-leads-form');
const csvDropZone = document.getElementById('csv-drop-zone');
const csvFileInput = document.getElementById('csv-file-input');
const browseTrigger = document.getElementById('browse-trigger');
const selectedFileInfo = document.getElementById('selected-file-info');
const uploadPreview = document.getElementById('upload-preview');
const previewCount = document.getElementById('preview-count');
const templateMessage = document.getElementById('template-message');
const btnSubmitUpload = document.getElementById('btn-submit-upload');

// Phase 3: Character Counter DOM Elements
const chatCharCounter = document.getElementById('chat-char-counter');
const templateCharCounter = document.getElementById('template-char-counter');

// Phase 6: Sidebar Filtering DOM Elements
const filterFromDate = document.getElementById('filter-from-date');
const filterToDate = document.getElementById('filter-to-date');
const btnClearDate = document.getElementById('btn-clear-date');

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

  // Phase 6: View Filters click handlers
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.dataset.filter;
      filterConversations();
    });
  });

  // Phase 6: Date Filters change handlers
  filterFromDate.addEventListener('change', (e) => {
    fromDate = e.target.value;
    filterConversations();
  });
  filterToDate.addEventListener('change', (e) => {
    toDate = e.target.value;
    filterConversations();
  });
  btnClearDate.addEventListener('click', () => {
    filterFromDate.value = '';
    filterToDate.value = '';
    fromDate = '';
    toDate = '';
    filterConversations();
  });
  chatForm.addEventListener('submit', handleSendMessage);
  btnDeleteChat.addEventListener('click', handleDeleteActiveConversation);
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
  const originalCopySvg = btnCopyWebhook.innerHTML;
  btnCopyWebhook.addEventListener('click', () => {
    navigator.clipboard.writeText(webhookUrlDisplay.textContent).then(() => {
      btnCopyWebhook.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="hsl(145, 65%, 48%)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      btnCopyWebhook.classList.add('copied');
      setTimeout(() => {
        btnCopyWebhook.innerHTML = originalCopySvg;
        btnCopyWebhook.classList.remove('copied');
      }, 2000);
    });
  });

  // Textarea auto-resize & character count
  messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight - 6) + 'px';
    updateCharCounter(this, chatCharCounter);
  });

  // Template message character count
  templateMessage.addEventListener('input', function() {
    updateCharCounter(this, templateCharCounter);
  });

  // Phase 2: Lead Upload Modal Event Listeners
  btnUploadLeads.addEventListener('click', () => {
    uploadLeadsModal.classList.add('open');
    resetLeadUploadState();
  });
  uploadClose.addEventListener('click', () => uploadLeadsModal.classList.remove('open'));
  uploadLeadsModal.addEventListener('click', (e) => {
    if (e.target === uploadLeadsModal) uploadLeadsModal.classList.remove('open');
  });

  // Trigger file browser
  browseTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    csvFileInput.click();
  });
  csvDropZone.addEventListener('click', () => csvFileInput.click());

  // Drag & drop handlers
  csvDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    csvDropZone.classList.add('dragover');
  });
  csvDropZone.addEventListener('dragleave', () => {
    csvDropZone.classList.remove('dragover');
  });
  csvDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    csvDropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleCsvFile(files[0]);
    }
  });

  csvFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleCsvFile(e.target.files[0]);
    }
  });

  uploadLeadsForm.addEventListener('submit', handleUploadLeadsSubmit);
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

function updateSenderDropdowns(settings) {
  const bulkvsNumber = settings.sender_number || '+18887885527';
  const fractelDefault = settings.fractel_sender_number || '8653456051';

  const options = [];
  
  // Add BulkVS as disabled/grayed out
  if (bulkvsNumber) {
    options.push({ value: bulkvsNumber, label: `BulkVS (${bulkvsNumber}) - Disabled`, disabled: true });
  }

  // Add ONLY the primary/default FracTEL number
  options.push({ value: fractelDefault, label: `FracTEL (${fractelDefault})`, disabled: false });

  const renderOption = opt => {
    if (opt.disabled) {
      return `<option value="${opt.value}" disabled style="color: #666; background-color: #1a1d24;">${opt.label}</option>`;
    } else {
      return `<option value="${opt.value}" selected>${opt.label}</option>`;
    }
  };

  // Populate composer sender select
  if (composerSenderSelect) {
    composerSenderSelect.innerHTML = options.map(renderOption).join('');
  }

  // Populate campaign sender select
  if (campaignSenderSelect) {
    campaignSenderSelect.innerHTML = options.map(renderOption).join('');
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

    if (settingFractelSender) settingFractelSender.value = settings.fractel_sender_number || '2005555185';
    if (settingFractelBrand) settingFractelBrand.value = settings.fractel_brand_id || 'B7PS8UH';
    if (settingFractelUsername) settingFractelUsername.value = settings.fractel_username || '';
    if (settingFractelPassword) settingFractelPassword.value = settings.fractel_password || '';

    updateSenderDropdowns(settings);
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
    case 'conversation_deleted':
      handleIncomingConversationDeleted(data);
      break;
  }
}

function handleIncomingConversationDeleted(data) {
  if (activeConversation && activeConversation.id === data.id) {
    resetChatToWelcomeBox();
  }
  loadConversations();
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
    // 1. Search query filter
    const name = (c.name || '').toLowerCase();
    const phone = c.phone_number.toLowerCase();
    const matchesSearch = name.includes(query) || phone.includes(query);
    if (!matchesSearch) return false;

    // 2. Response Status Filter (Phase 6)
    const hasReplies = c.last_inbound_at !== null;
    if (currentFilter === 'replied' && !hasReplies) return false;
    if (currentFilter === 'no-replies' && hasReplies) return false;

    // 3. Date Range Filter (Phase 6)
    const activityDate = getLocalDateString(c.last_message_at || c.created_at);
    if (activityDate) {
      if (fromDate && activityDate < fromDate) return false;
      if (toDate && activityDate > toDate) return false;
    }

    return true;
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
    const repliedDot = c.last_message_direction === 'inbound' ? `<span class="conv-replied-dot" title="New Reply"></span>` : '';

    item.innerHTML = `
      <div class="avatar">${initials}</div>
      <div class="conv-details">
        <div class="conv-meta">
          <span class="conv-name">${displayName}${repliedDot}</span>
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
  
  // Show input field and delete button
  chatComposerContainer.style.display = 'block';
  btnDeleteChat.style.display = 'block';
  updateCharCounter(messageInput, chatCharCounter);
  
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

  const fromNum = composerSenderSelect ? composerSenderSelect.value : null;

  const payload = {
    body: body,
    media_urls: mediaUrl ? [mediaUrl] : null,
    from_number: fromNum
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
      updateCharCounter(messageInput, chatCharCounter);
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

// 8.5. Delete Active Conversation Thread
async function handleDeleteActiveConversation() {
  if (!activeConversation) return;

  const confirmed = confirm(`Are you sure you want to delete the conversation thread with ${activeConversation.name || activeConversation.phone_number}? This will permanently delete all messages.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/conversations/${activeConversation.id}`, {
      method: 'DELETE'
    });

    if (res.ok) {
      resetChatToWelcomeBox();
      await loadConversations();
    } else {
      const err = await res.json();
      alert("Error deleting conversation: " + err.error);
    }
  } catch (err) {
    console.error("Delete conversation error:", err);
    alert("Connection error deleting conversation.");
  }
}

function resetChatToWelcomeBox() {
  activeConversation = null;
  
  // Reset active conversation sidebar selection styling
  document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('active'));

  // Reset Chat Header
  activeAvatar.textContent = '#';
  activeContactName.textContent = 'Select a conversation';
  activeContactPhone.textContent = 'Select or start a chat to send messages';
  
  // Hide inputs and delete button
  chatComposerContainer.style.display = 'none';
  btnDeleteChat.style.display = 'none';
  
  // Reset message feed placeholder
  messagesFeed.innerHTML = `
    <div class="feed-placeholder">
      <div class="welcome-box">
        <div class="welcome-icon">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="welcome-svg"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        </div>
        <h3>Welcome to Leadzer SMS Gateway</h3>
        <p>Select a contact from the sidebar or click "New Chat" to begin sending rate-limited messages securely.</p>
      </div>
    </div>
  `;
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
    bulkvs_token: settingToken.value.trim(),
    fractel_sender_number: settingFractelSender.value.trim(),
    fractel_brand_id: settingFractelBrand.value.trim(),
    fractel_username: settingFractelUsername.value.trim(),
    fractel_password: settingFractelPassword.value.trim()
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const updated = await res.json();
      settingsStatus.textContent = 'Settings saved successfully!';
      settingsStatus.className = 'settings-status success';
      
      updateSenderDropdowns(updated);
      
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

// Phase 2: CSV Parsing & Upload Functions
function resetLeadUploadState() {
  parsedLeads = [];
  csvFileInput.value = '';
  selectedFileInfo.style.display = 'none';
  selectedFileInfo.textContent = '';
  uploadPreview.style.display = 'none';
  previewCount.textContent = '0';
  templateMessage.value = '';
  updateCharCounter(templateMessage, templateCharCounter);
  btnSubmitUpload.disabled = true;
  btnSubmitUpload.textContent = 'Import & Queue';
}

function handleCsvFile(file) {
  if (!file.name.endsWith('.csv')) {
    alert("Please select a valid CSV file.");
    resetLeadUploadState();
    return;
  }

  selectedFileInfo.style.display = 'block';
  selectedFileInfo.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    parseCSV(text);
  };
  reader.onerror = function() {
    alert("Failed to read file.");
    resetLeadUploadState();
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  try {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) {
      alert("CSV file seems to be empty or missing data rows.");
      resetLeadUploadState();
      return;
    }

    // Split first line for headers
    const headers = splitCsvLine(lines[0]).map(h => h.trim().replace(/^["']|["']$/g, ''));
    
    // Find column indexes
    let phoneIdx = headers.findIndex(h => /phone|number|num|tel|mobile/i.test(h));
    let nameIdx = headers.findIndex(h => /name|contact|lead/i.test(h));

    // Fallbacks if headers don't match standard names
    if (phoneIdx === -1) {
      // If there are columns, default to index 1 or 0
      phoneIdx = headers.length > 1 ? 1 : 0;
    }
    if (nameIdx === -1 && headers.length > 1) {
      nameIdx = phoneIdx === 0 ? 1 : 0;
    }

    const tempLeads = [];
    
    // Process rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // Skip empty lines

      const columns = splitCsvLine(line).map(c => c.trim().replace(/^["']|["']$/g, ''));
      if (columns.length === 0) continue;

      const rawPhone = columns[phoneIdx !== -1 ? phoneIdx : 0] || '';
      // Strip formatting: keep numbers and plus
      const phone = rawPhone.replace(/[^\d+]/g, '');
      const name = nameIdx !== -1 && nameIdx < columns.length ? columns[nameIdx] : '';

      if (phone && phone.length >= 7) {
        tempLeads.push({ phone_number: phone, name: name || null });
      }
    }

    if (tempLeads.length === 0) {
      alert("No valid leads (with phone numbers) could be parsed from the CSV.");
      resetLeadUploadState();
      return;
    }

    parsedLeads = tempLeads;
    uploadPreview.style.display = 'block';
    previewCount.textContent = parsedLeads.length;
    btnSubmitUpload.disabled = false;
    btnSubmitUpload.textContent = `Import & Queue ${parsedLeads.length} Leads`;
    
    console.log("Successfully parsed leads:", parsedLeads);
  } catch (err) {
    console.error("CSV parse error:", err);
    alert("Error parsing CSV: " + err.message);
    resetLeadUploadState();
  }
}

// Custom CSV line splitter that handles quotes and commas correctly
function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' || char === "'") {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

async function handleUploadLeadsSubmit(e) {
  e.preventDefault();
  if (parsedLeads.length === 0) return;

  btnSubmitUpload.disabled = true;
  btnSubmitUpload.textContent = 'Importing...';

  const template = templateMessage.value.trim();
  const fromNum = campaignSenderSelect ? campaignSenderSelect.value : null;

  const payload = {
    leads: parsedLeads,
    message_template: template || null,
    from_number: fromNum
  };

  try {
    const res = await fetch('/api/leads/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      uploadLeadsModal.classList.remove('open');
      alert(`Success! Imported ${data.imported_count} leads and queued ${data.queued_count} messages.`);
      
      // Refresh app state
      await loadConversations();
      resetLeadUploadState();
    } else {
      const err = await res.json();
      alert("Error importing leads: " + err.error);
      btnSubmitUpload.disabled = false;
      btnSubmitUpload.textContent = `Import & Queue ${parsedLeads.length} Leads`;
    }
  } catch (err) {
    console.error("Lead upload error:", err);
    alert("Connection error uploading leads.");
    btnSubmitUpload.disabled = false;
    btnSubmitUpload.textContent = `Import & Queue ${parsedLeads.length} Leads`;
  }
}

// Phase 3: Character Counter & Segment Estimation Logic
function getSmsDetails(text) {
  if (!text) {
    return { count: 0, limit: 160, segments: 1, isUnicode: false };
  }
  
  // Check for non-GSM-7 characters
  const gsm7Regex = /^[\n\r a-zA-Z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\[~\]|€\\]*$/;
  const isUnicode = !gsm7Regex.test(text);
  
  const count = text.length;
  let limit = 160;
  let segments = 1;
  
  if (isUnicode) {
    limit = 70;
    if (count > 70) {
      segments = Math.ceil(count / 67);
      limit = segments * 67;
    }
  } else {
    // Extended GSM-7 characters count as double
    const extendedRegex = /[\^{}\[~\]|€\\]/g;
    const extendedCount = (text.match(extendedRegex) || []).length;
    const totalCount = count + extendedCount;
    
    limit = 160;
    if (totalCount > 160) {
      segments = Math.ceil(totalCount / 153);
      limit = segments * 153;
    }
    return { count: totalCount, limit, segments, isUnicode };
  }
  
  return { count, limit, segments, isUnicode };
}

function updateCharCounter(textarea, counterEl) {
  const text = textarea.value;
  const details = getSmsDetails(text);
  
  let label = `${details.count} / ${details.limit} (${details.segments} segment${details.segments > 1 ? 's' : ''})`;
  if (details.isUnicode) {
    label += ' • Unicode';
  }
  
  counterEl.textContent = label;
  
  // Styles based on segments
  counterEl.className = 'char-counter';
  if (details.segments === 2) {
    counterEl.classList.add('warning');
  } else if (details.segments >= 3) {
    counterEl.classList.add('danger');
  }
}

// Phase 6: Helper to convert ISO/SQLite datetime string to local YYYY-MM-DD string
function getLocalDateString(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  
  const parts = dateStr.split(' ');
  if (parts[0] && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
    return parts[0];
  }
  
  try {
    const date = new Date(dateStr);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (e) {
    return null;
  }
}
