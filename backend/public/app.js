// Global Fetch Interceptor for 401 Unauthorized
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  try {
    const response = await originalFetch(...args);
    if (response.status === 401) {
      console.warn("Session expired or unauthorized. Redirecting to login...");
      window.location.href = '/login';
      return new Response(JSON.stringify({ error: 'Session expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return response;
  } catch (err) {
    throw err;
  }
};

// Application State
let activeConversation = null;
let conversations = [];
let messages = [];
let ws = null;
let wsReconnectTimer = null;
let parsedLeads = []; // Phase 2: Parsed leads storage
let currentStatusFilter = 'responded'; // Status filter (responded/pending)
let currentStageFilter = 'all'; // Stage filter (Stage 1/Stage 2/Stage 3/all)
let fromDate = '';
let toDate = '';
let selectedConversations = new Set(); // Selection/Bulk Actions state


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

// Campaign Modal DOM Elements
const btnSendCampaign = document.getElementById('btn-send-campaign');
const campaignModal = document.getElementById('campaign-modal');
const campaignClose = document.getElementById('campaign-close');
const campaignForm = document.getElementById('campaign-form');
const campaignMessageText = document.getElementById('campaign-message-text');
const campaignCharCounter = document.getElementById('campaign-char-counter');
const btnSubmitCampaign = document.getElementById('btn-submit-campaign');
const campaignBulkSenderSelect = document.getElementById('campaign-bulk-sender-select');

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

// Selection / Bulk Actions DOM Elements
const bulkSenderSelect = document.getElementById('bulk-sender-select');

// 1. Initial Load & Setup
window.addEventListener('DOMContentLoaded', () => {
  // Check URL parameters for imported leads
  const urlParams = new URLSearchParams(window.location.search);
  const importSource = urlParams.get('import');
  const encodedData = urlParams.get('data');
  if (importSource === 'storm-map-demo' && encodedData) {
    try {
      const decodedJson = decodeURIComponent(escape(atob(encodedData)));
      const importedLeads = JSON.parse(decodedJson);
      if (Array.isArray(importedLeads)) {
        localStorage.setItem('storm_map_imported_leads', JSON.stringify(importedLeads));
        const county = urlParams.get('county') || '';
        const state = urlParams.get('state') || '';
        localStorage.setItem('storm_map_imported_county', county);
        localStorage.setItem('storm_map_imported_state', state);
        
        currentStatusFilter = 'storm-demo';
        
        // Remove query parameters from address bar
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (err) {
      console.error("Failed to parse imported leads:", err);
    }
  }

  loadConversations();
  loadSettings();
  loadRecentActivity();
  setupWebSockets();
  updateStormLeadsBadge();
  
  // Set webhook URL based on current host
  const host = window.location.host;
  const protocol = window.location.protocol;
  webhookUrlDisplay.textContent = `${protocol}//${host}/webhook/inbound`;

  // Event Listeners
  searchInput.addEventListener('input', filterConversations);

  // Status Filters click handlers
  document.querySelectorAll('.status-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('.status-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentStatusFilter = pill.dataset.status;
      filterConversations();
      toggleViewsBasedOnFilter();
    });
  });

  // If initial status filter is storm-demo, activate the pill and views
  if (currentStatusFilter === 'storm-demo') {
    document.querySelectorAll('.status-pill').forEach(p => {
      if (p.dataset.status === 'storm-demo') {
        p.classList.add('active');
      } else {
        p.classList.remove('active');
      }
    });
    toggleViewsBasedOnFilter();
  }

  // Clear storm leads button handler
  const btnClearStormLeads = document.getElementById('btn-clear-storm-leads');
  if (btnClearStormLeads) {
    btnClearStormLeads.addEventListener('click', () => {
      if (confirm("Are you sure you want to clear all imported demo leads?")) {
        localStorage.removeItem('storm_map_imported_leads');
        localStorage.removeItem('storm_map_imported_county');
        localStorage.removeItem('storm_map_imported_state');
        updateStormLeadsBadge();
        if (currentStatusFilter === 'storm-demo') {
          renderConversations();
          renderStormLeadsTable();
        }
      }
    });
  }

  // Stage Filters click handlers
  document.querySelectorAll('.stage-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('.stage-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentStageFilter = pill.dataset.stage;
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

  // Toggle Test Tool
  const btnToggleTest = document.getElementById('btn-toggle-test');
  const quickTestForm = document.getElementById('quick-test-form');
  if (btnToggleTest && quickTestForm) {
    btnToggleTest.addEventListener('click', () => {
      quickTestForm.classList.toggle('collapsed');
      btnToggleTest.classList.toggle('collapsed');
    });
  }

  // Quick SMS Test Form submission
  if (quickTestForm) {
    quickTestForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const phoneInput = document.getElementById('test-phone');
      const senderSelect = document.getElementById('test-sender');
      const bodyInput = document.getElementById('test-body');
      const statusMsg = document.getElementById('test-status-msg');
      const btnSubmit = document.getElementById('btn-submit-test');

      if (!phoneInput || !bodyInput) return;

      const phone = phoneInput.value.trim();
      const body = bodyInput.value.trim();
      const fromNum = senderSelect ? senderSelect.value : null;

      if (!phone || !body) return;

      // Disable button
      btnSubmit.disabled = true;
      statusMsg.textContent = 'Sending connection test...';
      statusMsg.className = 'test-status-msg';

      try {
        // 1. Create or get conversation
        const convRes = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone_number: phone })
        });

        if (!convRes.ok) {
          const err = await convRes.json();
          throw new Error(err.error || "Failed to create conversation");
        }

        const conv = await convRes.json();

        // 2. Send the message
        const msgRes = await fetch(`/api/conversations/${conv.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: body,
            from_number: fromNum
          })
        });

        if (!msgRes.ok) {
          const err = await msgRes.json();
          throw new Error(err.error || "Failed to queue message");
        }

        // Success!
        statusMsg.textContent = 'SMS queued successfully!';
        statusMsg.className = 'test-status-msg success';
        
        // Reset message body only
        bodyInput.value = '';
        
        // Reload conversations and activity
        loadConversations();
        loadRecentActivity();

        // Clear status after 3 seconds
        setTimeout(() => {
          statusMsg.textContent = '';
          statusMsg.className = 'test-status-msg';
        }, 3000);

      } catch (err) {
        console.error("Test SMS failed:", err);
        statusMsg.textContent = err.message || "Test SMS failed.";
        statusMsg.className = 'test-status-msg error';
      } finally {
        btnSubmit.disabled = false;
      }
    });
  }

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

  // Settings Modal Toggle handlers
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close');

  btnOpenSettings.addEventListener('click', () => {
    settingsModal.classList.add('open');
  });

  settingsClose.addEventListener('click', () => {
    settingsModal.classList.remove('open');
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.classList.remove('open');
  });

  // Bulk messaging elements
  const chkSelectAllConvs = document.getElementById('chk-select-all-convs');
  const btnBulkMsg = document.getElementById('btn-bulk-msg');
  const bulkMessageModal = document.getElementById('bulk-message-modal');
  const bulkMessageClose = document.getElementById('bulk-message-close');
  const bulkMessageForm = document.getElementById('bulk-message-form');
  const bulkMessageText = document.getElementById('bulk-message-text');
  const bulkCharCounter = document.getElementById('bulk-char-counter');
  const btnSubmitBulk = document.getElementById('btn-submit-bulk');

  // Select all checkbox handler
  chkSelectAllConvs.addEventListener('change', (e) => {
    const filtered = getFilteredConversations();

    if (e.target.checked) {
      filtered.forEach(c => selectedConversations.add(c.id));
    } else {
      filtered.forEach(c => selectedConversations.delete(c.id));
    }
    
    // Re-render conversation checkboxes to show selected state
    renderConversations();
  });

  // Open Bulk Message Modal
  btnBulkMsg.addEventListener('click', () => {
    if (selectedConversations.size === 0) return;
    
    document.getElementById('bulk-recipients-count').textContent = selectedConversations.size;
    bulkMessageText.value = '';
    updateCharCounter(bulkMessageText, bulkCharCounter);
    
    // Populate bulk sender options from active settings
    const composerOptions = Array.from(composerSenderSelect.options).map(opt => {
      return `<option value="${opt.value}" ${opt.disabled ? 'disabled style="color: #666; background-color: #1a1d24;"' : 'selected'}>${opt.text}</option>`;
    }).join('');
    bulkSenderSelect.innerHTML = composerOptions;

    bulkMessageModal.classList.add('open');
  });

  // Close Bulk Message Modal
  bulkMessageClose.addEventListener('click', () => bulkMessageModal.classList.remove('open'));
  bulkMessageModal.addEventListener('click', (e) => {
    if (e.target === bulkMessageModal) bulkMessageModal.classList.remove('open');
  });

  // Bulk Message Character Counter
  bulkMessageText.addEventListener('input', function() {
    updateCharCounter(this, bulkCharCounter);
  });

  // Submit Bulk Message Campaign
  bulkMessageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (selectedConversations.size === 0) return;

    btnSubmitBulk.disabled = true;
    btnSubmitBulk.textContent = 'Sending...';

    const text = bulkMessageText.value.trim();
    const fromNum = bulkSenderSelect.value;
    const conversationIds = Array.from(selectedConversations);

    try {
      const res = await fetch('/api/conversations/bulk-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_ids: conversationIds,
          message_text: text,
          from_number: fromNum
        })
      });

      if (res.ok) {
        const data = await res.json();
        bulkMessageModal.classList.remove('open');
        alert(`Success! Queued ${data.queued_count} bulk messages.`);
        
        // Clear selection & reload
        selectedConversations.clear();
        await loadConversations();
      } else {
        const err = await res.json();
        alert("Error sending bulk messages: " + err.error);
      }
    } catch (err) {
      console.error("Bulk messaging submit error:", err);
      alert("Connection error sending bulk messages.");
    } finally {
      btnSubmitBulk.disabled = false;
      btnSubmitBulk.textContent = 'Send Message';
    }
  });

  // Campaign Modal event listeners
  if (btnSendCampaign) {
    btnSendCampaign.addEventListener('click', () => {
      // Clear checkboxes by default or select Stage 1
      document.querySelectorAll('input[name="target-stage"]').forEach(chk => {
        chk.checked = (chk.value === 'Stage 1');
      });
      campaignMessageText.value = '';
      updateCharCounter(campaignMessageText, campaignCharCounter);

      // Populate campaign bulk sender options
      const composerOptions = Array.from(composerSenderSelect.options).map(opt => {
        return `<option value="${opt.value}" ${opt.disabled ? 'disabled style="color: #666; background-color: #1a1d24;"' : 'selected'}>${opt.text}</option>`;
      }).join('');
      campaignBulkSenderSelect.innerHTML = composerOptions;

      campaignModal.classList.add('open');
    });
  }

  if (campaignClose) {
    campaignClose.addEventListener('click', () => campaignModal.classList.remove('open'));
  }
  
  if (campaignModal) {
    campaignModal.addEventListener('click', (e) => {
      if (e.target === campaignModal) campaignModal.classList.remove('open');
    });
  }

  // Campaign Message Character Counter
  if (campaignMessageText) {
    campaignMessageText.addEventListener('input', function() {
      updateCharCounter(this, campaignCharCounter);
    });
  }

  // Campaign Form Submission
  if (campaignForm) {
    campaignForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const checkedStages = Array.from(document.querySelectorAll('input[name="target-stage"]:checked')).map(chk => chk.value);
      if (checkedStages.length === 0) {
        alert("Please select at least one target stage.");
        return;
      }

      btnSubmitCampaign.disabled = true;
      btnSubmitCampaign.textContent = 'Sending...';

      const text = campaignMessageText.value.trim();
      const fromNum = campaignBulkSenderSelect.value;

      try {
        const res = await fetch('/api/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stages: checkedStages,
            message_text: text,
            from_number: fromNum
          })
        });

        if (res.ok) {
          const data = await res.json();
          campaignModal.classList.remove('open');
          alert(`Success! Queued ${data.queued_count} campaign messages.`);
          
          // Reload conversations
          await loadConversations();
        } else {
          const err = await res.json();
          alert("Error sending campaign: " + err.error);
        }
      } catch (err) {
        console.error("Campaign submit error:", err);
        alert("Connection error sending campaign.");
      } finally {
        btnSubmitCampaign.disabled = false;
        btnSubmitCampaign.textContent = 'Send Campaign';
      }
    });
  }

  // Logout handler
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/auth/logout', { method: 'POST' });
        if (res.ok) {
          window.location.href = '/login';
        } else {
          alert('Failed to log out.');
        }
      } catch (err) {
        console.error('Logout error:', err);
        alert('Network error during logout.');
      }
    });
  }
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

  // Populate campaign bulk sender select
  if (campaignBulkSenderSelect) {
    campaignBulkSenderSelect.innerHTML = options.map(renderOption).join('');
  }

  // Populate bulk sender select
  if (bulkSenderSelect) {
    bulkSenderSelect.innerHTML = options.map(renderOption).join('');
  }

  // Populate test sender select
  const testSenderSelect = document.getElementById('test-sender');
  if (testSenderSelect) {
    testSenderSelect.innerHTML = options.map(renderOption).join('');
  }

  // Update connection cards status in right panel
  updateGatewayStatusUI(settings);
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

  ws.onclose = (event) => {
    if (event && event.code === 4001) {
      console.warn("WebSocket closed (unauthorized). Redirecting to login...");
      window.location.href = '/login';
      return;
    }

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
    case 'conversation_read':
      handleIncomingConversationRead(data);
      break;
  }
}

function handleIncomingConversationDeleted(data) {
  if (activeConversation && activeConversation.id === data.id) {
    resetChatToWelcomeBox();
  }
  loadConversations();
}

function handleIncomingConversationRead(data) {
  const conv = conversations.find(c => c.id === data.id);
  if (conv) {
    conv.unread = 0;
    renderConversations();
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
  
  // Update NOC timeline activity
  loadRecentActivity();
}

// Handle Inbound or New Outbound message websocket push
function handleIncomingNewMessage(msg) {
  // If message belongs to active chat, render it
  if (activeConversation && msg.conversation_id === activeConversation.id) {
    messages.push(msg);
    appendMessageToFeed(msg);
    scrollToBottom();
    // Since it's the active conversation, mark it read on server immediately
    fetch(`/api/conversations/${activeConversation.id}/read`, { method: 'POST' }).catch(e => {});
  }
  
  // Reload conversation list to show correct preview
  loadConversations();
  // Update NOC timeline activity
  loadRecentActivity();
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
        const timeStr = formatMessageTimestamp(new Date());
        // update text content
        const timeNode = meta.firstChild;
        if (timeNode) timeNode.textContent = timeStr + ' ';
      }
    }
  }
  
  // Reload conversations side bar preview
  loadConversations();
  // Update NOC timeline activity
  loadRecentActivity();
}

function getFilteredConversations() {
  const query = searchInput.value.toLowerCase().trim();
  
  if (currentStatusFilter === 'storm-demo') {
    const leadsJson = localStorage.getItem('storm_map_imported_leads');
    const leads = leadsJson ? JSON.parse(leadsJson) : [];
    
    return leads
      .map((lead, index) => ({
        id: `lead-${index}`,
        phone_number: lead.phone,
        name: lead.name,
        isLead: true,
        leadData: lead,
        last_message_text: `${lead.stormType || 'Storm'} Lead · ${lead.confidence || 'High'} Conf`,
        last_message_at: lead.stormDate,
        unread: false
      }))
      .filter(c => {
        const name = (c.name || '').toLowerCase();
        const phone = c.phone_number.toLowerCase();
        return name.includes(query) || phone.includes(query);
      });
  }

  return conversations.filter(c => {
    // 1. Search query filter
    const name = (c.name || '').toLowerCase();
    const phone = c.phone_number.toLowerCase();
    const matchesSearch = name.includes(query) || phone.includes(query);
    if (!matchesSearch) return false;

    // 2. Status & Stage Filters
    const isResponded = c.stage && c.stage.endsWith('-Responded');
    const status = isResponded ? 'responded' : 'pending';
    
    if (currentStatusFilter !== status) return false;
    
    if (currentStageFilter !== 'all') {
      const stageBase = c.stage.replace('-Responded', '');
      if (stageBase !== currentStageFilter) return false;
    }

    // 3. Date Range Filter
    const activityDate = getLocalDateString(c.last_message_at || c.created_at);
    if (activityDate) {
      if (fromDate && activityDate < fromDate) return false;
      if (toDate && activityDate > toDate) return false;
    }

    return true;
  });
}

// 5. Render Sidebar conversations
function renderConversations() {
  const convListHeader = document.getElementById('conv-list-header');
  
  if (conversations.length === 0) {
    conversationsList.innerHTML = `<div class="list-placeholder">No conversations started</div>`;
    if (convListHeader) convListHeader.style.display = 'none';
    return;
  }

  conversationsList.innerHTML = '';
  
  const filtered = getFilteredConversations();

  // Update selection header
  if (convListHeader) {
    if (filtered.length > 0) {
      convListHeader.style.display = 'flex';
      document.getElementById('visible-convs-count').textContent = filtered.length;
    } else {
      convListHeader.style.display = 'none';
    }
  }

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
      timeStr = formatMessageTimestamp(c.last_message_at);
    }

    const preview = c.last_message_text || 'No messages';
    const isUnread = c.unread === 1 || c.unread === '1' || c.unread === true;
    const repliedDot = isUnread && (!activeConversation || activeConversation.id !== c.id) ? `<span class="conv-replied-dot" title="New Reply"></span>` : '';
    const isChecked = selectedConversations.has(c.id);

    item.innerHTML = `
      <label class="conv-checkbox-container" onclick="event.stopPropagation()">
        <input type="checkbox" class="conv-select-checkbox" data-id="${c.id}" ${isChecked ? 'checked' : ''}>
        <span class="checkbox-custom"></span>
      </label>
      <div class="avatar">${initials}</div>
      <div class="conv-details">
        <div class="conv-meta">
          <span class="conv-name">${displayName}${repliedDot}</span>
          <span class="conv-time">${timeStr}</span>
        </div>
        <div class="conv-preview">${preview}</div>
      </div>
    `;

    // Handle checkbox change
    const checkbox = item.querySelector('.conv-select-checkbox');
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedConversations.add(c.id);
      } else {
        selectedConversations.delete(c.id);
      }
      updateBulkActionBarUI(filtered);
    });

    item.addEventListener('click', () => selectConversation(c));
    conversationsList.appendChild(item);
  });

  updateBulkActionBarUI(filtered);
}

function filterConversations() {
  clearSelection();
  renderConversations();
}

// 6. Select active chat
async function selectConversation(conv) {
  activeConversation = conv;
  
  if (conv && conv.isLead) {
    // UI Selection styling
    document.querySelectorAll('.conversation-item').forEach(el => {
      el.classList.remove('active');
      if (el.dataset.id === conv.id) {
        el.classList.add('active');
      }
    });

    const stormLeadsView = document.getElementById('storm-leads-view');
    if (stormLeadsView) stormLeadsView.style.display = 'none';
    
    chatHeader.style.display = 'flex';
    messagesFeed.style.display = 'block';
    chatComposerContainer.style.display = 'block';
    
    // Setup Chat Header
    const initials = conv.name ? conv.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase() : '#';
    activeAvatar.textContent = initials;
    activeContactName.textContent = conv.name || conv.phone_number;
    activeContactPhone.textContent = conv.leadData.stormType === "Demo Form" 
      ? `Demo Form Submission · ${conv.leadData.roofAge}`
      : `Demo Lead · ${conv.leadData.address}, ${conv.leadData.city}, ${conv.leadData.state}`;
    
    btnDeleteChat.style.display = 'none';
    
    let detailsHtml = '';
    if (conv.leadData.stormType === "Demo Form") {
      detailsHtml = `
            <div><strong>Requested Plan:</strong> <span style="color: var(--text-main);">${conv.leadData.roofAge}</span></div>
            <div><strong>Requested Market:</strong> <span style="color: var(--text-main);">${conv.leadData.county}</span></div>
            <div><strong>Email Address:</strong> <span style="color: var(--text-main);">${conv.leadData.email}</span></div>
            <div><strong>Submission Type:</strong> <span class="hazard-badge demo-form">${conv.leadData.stormType}</span></div>
            <div><strong>Confidence Score:</strong> <span class="confidence-badge ${conv.leadData.confidence.toLowerCase()}">${conv.leadData.confidence}</span></div>
      `;
    } else {
      detailsHtml = `
            <div><strong>Property Address:</strong> <span style="color: var(--text-main);">${conv.leadData.address}, ${conv.leadData.city}, ${conv.leadData.state} ${conv.leadData.zip}</span></div>
            <div><strong>County:</strong> <span style="color: var(--text-main);">${conv.leadData.county}</span></div>
            <div><strong>Roof Age:</strong> <span style="color: var(--text-main);">${conv.leadData.roofAge}</span></div>
            <div><strong>Storm Hazard:</strong> <span style="color: var(--text-main);">${conv.leadData.stormType} (${conv.leadData.stormDate})</span></div>
            ${conv.leadData.hailSize !== '-' ? `<div><strong>Hail Size:</strong> <span style="color: var(--text-main);">${conv.leadData.hailSize}</span></div>` : ''}
            ${conv.leadData.windSpeed !== '-' ? `<div><strong>Wind Speed:</strong> <span style="color: var(--text-main);">${conv.leadData.windSpeed}</span></div>` : ''}
            <div><strong>Confidence Score:</strong> <span class="confidence-badge ${conv.leadData.confidence.toLowerCase()}">${conv.leadData.confidence}</span></div>
      `;
    }

    messagesFeed.innerHTML = `
      <div class="feed-placeholder">
        <div class="welcome-box" style="text-align: left; max-width: 500px; padding: 20px; border: 1px solid var(--border-color); background: var(--bg-card); box-shadow: 0 4px 12px rgba(0,0,0,0.15); margin-top: 10px;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
            <div class="avatar" style="background: var(--primary-gradient); color: white; border: none;">${initials}</div>
            <div>
              <h3 style="font-family: var(--font-heading); font-size: 15px; color: var(--text-main); margin: 0;">${conv.name}</h3>
              <p class="subtext" style="margin: 2px 0 0 0;">${conv.phone_number}</p>
            </div>
          </div>
          <div style="font-size: 12px; line-height: 1.6; display: flex; flex-direction: column; gap: 8px; color: var(--text-muted);">
            ${detailsHtml}
          </div>
          <div style="margin-top: 16px; font-size: 11px; font-style: italic; color: var(--text-muted); border-top: 1px solid var(--border-color); padding-top: 12px;">
            Type a message below to send an SMS to this contact. Sending a message will automatically start a real conversation.
          </div>
        </div>
      </div>
    `;
    
    let templateText = '';
    if (conv.leadData.stormType === "Demo Form") {
      const firstName = conv.name.split(' ')[0];
      const planName = conv.leadData.roofAge || 'Quarterly Lead Plan';
      const requestedMarket = conv.leadData.county || 'your market';
      templateText = `Hello ${firstName}, thank you for requesting pricing for the ${planName} in ${requestedMarket}. This is Braden from StormTarget. Do you have time for a quick call?`;
    } else {
      templateText = `Hello ${conv.name}, we noticed your home at ${conv.leadData.address} in ${conv.leadData.county || localStorage.getItem('storm_map_imported_county') || ''} County was in the path of the recent ${conv.leadData.stormType || 'storm'}. Would you like a free inspection?`;
    }
    messageInput.value = templateText;
    updateCharCounter(messageInput, chatCharCounter);
    return;
  }

  // Reset unread status immediately on click
  conv.unread = 0;
  renderConversations();
  
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
  const timeStr = formatMessageTimestamp(date);

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

  let convId = activeConversation.id;
  if (activeConversation.isLead) {
    try {
      const convRes = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number: activeConversation.phone_number,
          name: activeConversation.name
        })
      });

      if (!convRes.ok) {
        const err = await convRes.json();
        throw new Error(err.error || "Failed to create conversation");
      }

      const conv = await convRes.json();
      convId = conv.id;
      
      const leadsJson = localStorage.getItem('storm_map_imported_leads');
      if (leadsJson) {
        let leads = JSON.parse(leadsJson);
        const idx = leads.findIndex(l => l.phone === activeConversation.phone_number);
        if (idx !== -1) {
          leads.splice(idx, 1);
          localStorage.setItem('storm_map_imported_leads', JSON.stringify(leads));
          updateStormLeadsBadge();
        }
      }
    } catch (err) {
      console.error("Failed to create conversation for lead:", err);
      alert("Error starting conversation: " + err.message);
      btnSend.disabled = false;
      return;
    }
  }

  const payload = {
    body: body,
    media_urls: mediaUrl ? [mediaUrl] : null,
    from_number: fromNum
  };

  try {
    const res = await fetch(`/api/conversations/${convId}/messages`, {
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
      
      if (activeConversation.isLead) {
        document.querySelectorAll('.status-pill').forEach(p => {
          if (p.dataset.status === 'pending') {
            p.click();
          }
        });
        setTimeout(async () => {
          await loadConversations();
          const newConv = conversations.find(c => c.id === convId);
          if (newConv) {
            selectConversation(newConv);
          }
        }, 300);
      }
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

// Phase 8: Helper to format message timestamp to date and time (e.g. Jun 8, 12:45 PM)
function formatMessageTimestamp(dateInput) {
  if (!dateInput) return '';
  const date = new Date(dateInput);
  return date.toLocaleString([], { 
    month: 'short', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit' 
  });
}

// Selection & Bulk Action Helpers
function clearSelection() {
  selectedConversations.clear();
  const chkSelectAllConvs = document.getElementById('chk-select-all-convs');
  if (chkSelectAllConvs) chkSelectAllConvs.checked = false;
}

function updateBulkActionBarUI(filteredList) {
  const chkSelectAllConvs = document.getElementById('chk-select-all-convs');
  const btnBulkMsg = document.getElementById('btn-bulk-msg');
  if (!chkSelectAllConvs || !btnBulkMsg) return;

  // Count visible checked items
  let selectedVisibleCount = 0;
  filteredList.forEach(c => {
    if (selectedConversations.has(c.id)) selectedVisibleCount++;
  });

  chkSelectAllConvs.checked = filteredList.length > 0 && selectedVisibleCount === filteredList.length;
  
  if (selectedConversations.size > 0) {
    btnBulkMsg.disabled = false;
    btnBulkMsg.querySelector('span').textContent = `Message Selected (${selectedConversations.size})`;
  } else {
    btnBulkMsg.disabled = true;
    btnBulkMsg.querySelector('span').textContent = 'Message Selected';
  }
}

// Right Panel NOC Station Helpers
function updateGatewayStatusUI(settings) {
  const connBulkvsDid = document.getElementById('conn-bulkvs-did');
  const connBulkvsPace = document.getElementById('conn-bulkvs-pace');
  const connFractelDid = document.getElementById('conn-fractel-did');
  const connFractelBrand = document.getElementById('conn-fractel-brand');
  const connBulkvsStatus = document.getElementById('conn-bulkvs-status');
  const connFractelStatus = document.getElementById('conn-fractel-status');

  if (connBulkvsDid) connBulkvsDid.textContent = settings.sender_number || 'Not Set';
  if (connBulkvsPace) connBulkvsPace.textContent = `${settings.send_interval_ms || 2000} ms`;
  if (connFractelDid) connFractelDid.textContent = settings.fractel_sender_number || 'Not Set';
  if (connFractelBrand) connFractelBrand.textContent = settings.fractel_brand_id || 'Not Set';

  // Toggle active dots based on credentials configuration
  if (connBulkvsStatus) {
    if (settings.bulkvs_username && settings.bulkvs_token) {
      connBulkvsStatus.classList.add('active');
    } else {
      connBulkvsStatus.classList.remove('active');
    }
  }

  if (connFractelStatus) {
    if (settings.fractel_username && settings.fractel_password) {
      connFractelStatus.classList.add('active');
    } else {
      connFractelStatus.classList.remove('active');
    }
  }
}

async function loadRecentActivity() {
  const activityTimeline = document.getElementById('activity-timeline');
  if (!activityTimeline) return;

  try {
    const res = await fetch('/api/queue/recent?limit=10');
    if (!res.ok) throw new Error("Failed to fetch recent queue activity");
    const messages = await res.json();

    if (messages.length === 0) {
      activityTimeline.innerHTML = '<div class="activity-empty-state">No recent activity detected.</div>';
      return;
    }

    activityTimeline.innerHTML = messages.map(msg => renderTimelineItem(msg)).join('');
  } catch (err) {
    console.error("Error loading recent activity:", err);
  }
}

function renderTimelineItem(msg) {
  let title = '';
  const directionStr = msg.direction === 'inbound' ? 'Inbound' : 'Outbound';
  const nameOrPhone = msg.contact_name || (msg.direction === 'inbound' ? msg.from_number : msg.to_number);
  
  if (msg.direction === 'inbound') {
    title = `Inbound from ${nameOrPhone}`;
  } else {
    title = `Outbound to ${nameOrPhone}`;
  }

  const timeAgoStr = formatRelativeTime(msg.created_at);
  const bodyText = msg.body || (msg.media_urls ? '[Attachment]' : '');
  const statusClass = msg.direction === 'inbound' ? 'received' : msg.status;
  const statusLabel = msg.direction === 'inbound' ? 'received' : msg.status;

  return `
    <div class="timeline-item ${statusClass}" data-activity-id="${msg.id}">
      <div class="timeline-badge"></div>
      <div class="timeline-header">
        <span class="timeline-title">${title}</span>
        <span class="timeline-time">${timeAgoStr}</span>
      </div>
      <div class="timeline-body" title="${bodyText} (${statusLabel})">${bodyText}</div>
    </div>
  `;
}

// Simple time ago formatter
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const cleanDateStr = dateStr.replace(' ', 'T');
  const date = new Date(cleanDateStr);
  if (isNaN(date.getTime())) return dateStr;

  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Storm Leads UI Helper Functions
function toggleViewsBasedOnFilter() {
  const stormLeadsView = document.getElementById('storm-leads-view');
  
  if (currentStatusFilter === 'storm-demo') {
    chatHeader.style.display = 'none';
    messagesFeed.style.display = 'none';
    chatComposerContainer.style.display = 'none';
    
    if (stormLeadsView) {
      stormLeadsView.style.display = 'flex';
      renderStormLeadsTable();
    }
  } else {
    if (activeConversation && !activeConversation.isLead) {
      chatHeader.style.display = 'flex';
      messagesFeed.style.display = 'block';
      chatComposerContainer.style.display = 'block';
    } else {
      chatHeader.style.display = 'flex';
      messagesFeed.style.display = 'block';
      chatComposerContainer.style.display = 'none';
      if (activeConversation && activeConversation.isLead) {
        resetChatToWelcomeBox();
      }
    }
    
    if (stormLeadsView) {
      stormLeadsView.style.display = 'none';
    }
  }
}

function renderStormLeadsTable() {
  const tableBody = document.getElementById('storm-leads-table-body');
  if (!tableBody) return;
  
  const leadsJson = localStorage.getItem('storm_map_imported_leads');
  const leads = leadsJson ? JSON.parse(leadsJson) : [];
  
  if (leads.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 40px;">
          No demo leads imported. Run a scan in the Storm Map app and click "Send Leads to SMS App".
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = '';
  leads.forEach((lead, index) => {
    const row = document.createElement('tr');
    const hazardClass = (lead.stormType || 'hail').toLowerCase();
    const confClass = (lead.confidence || 'high').toLowerCase();
    
    row.innerHTML = `
      <td style="font-weight: 600; color: var(--text-main);">${lead.name}</td>
      <td style="color: var(--text-muted);">${lead.address}, ${lead.city}, ${lead.state}</td>
      <td style="font-family: monospace; color: var(--text-muted);">${lead.phone}</td>
      <td style="color: var(--text-muted);">${lead.roofAge}</td>
      <td>
        <span class="hazard-badge ${hazardClass}">${lead.stormType}</span>
      </td>
      <td>
        <span class="confidence-badge ${confClass}">${lead.confidence}</span>
      </td>
      <td style="text-align: right;">
        <button type="button" class="btn-primary btn-small btn-send-sms" data-index="${index}" style="padding: 6px 12px; font-size: 11px; display: inline-flex; justify-content: center; align-items: center; cursor: pointer; border-radius: 4px;">
          Send SMS
        </button>
      </td>
    `;
    
    row.querySelector('.btn-send-sms').addEventListener('click', () => {
      const leadConv = {
        id: `lead-${index}`,
        phone_number: lead.phone,
        name: lead.name,
        isLead: true,
        leadData: lead,
        last_message_text: `${lead.stormType || 'Storm'} Lead · ${lead.confidence || 'High'} Conf`,
        last_message_at: lead.stormDate,
        unread: false
      };
      selectConversation(leadConv);
    });
    
    tableBody.appendChild(row);
  });
}

function updateStormLeadsBadge() {
  const badge = document.getElementById('storm-demo-count');
  const leadsJson = localStorage.getItem('storm_map_imported_leads');
  const leads = leadsJson ? JSON.parse(leadsJson) : [];
  
  if (badge) {
    if (leads.length > 0) {
      badge.textContent = leads.length;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

