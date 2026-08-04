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

/* ------------------------------------------------------------------
 * Reply classification
 *
 * The keyword lists live in ONE place: public/lib/classification.js,
 * loaded as a plain script before this file and shared verbatim with
 * the server. Never re-implement them here.
 * ------------------------------------------------------------------ */
const Classify = window.SmsClassification;
const CLS = Classify.CLASSIFICATIONS;

/**
 * The classification of a conversation's latest reply.
 * Prefers reply_classification computed and stored by the server; falls
 * back to classifying locally only for records written before that column
 * existed.
 */
function replyClassificationOf(conv) {
  if (conv.reply_classification) return conv.reply_classification;
  if (conv.last_inbound_text) return Classify.classifyReply(conv.last_inbound_text);
  return null;
}

/* ------------------------------------------------------------------
 * Folders and views
 *
 * A conversation lands in exactly one "view". Views are grouped into
 * the folders shown in the sidebar; a folder's count is the sum of
 * its views.
 *
 * Reply classification and business disposition are SEPARATE concepts
 * and both are preserved. Placement precedence:
 *   1. Hard suppression (opted out / wrong number) — legal state wins.
 *   2. Manual disposition — the human's business decision.
 *   3. Reply classification — the automatic read.
 * ------------------------------------------------------------------ */
const FOLDERS = {
  'new':        { views: ['new'] },
  'hot':        { views: ['all_hot', 'appointment', 'follow_up'] },
  'customer':   { views: ['customer'] },
  'closed':     { views: ['all_closed', 'no', 'unqualified', 'opted_out', 'wrong_number'] },
  'pending':    { views: ['pending'] },
  'storm-demo': { views: ['storm-demo'] }
};

const ALL_VIEWS = Object.values(FOLDERS).flatMap(f => f.views);

// Views whose rows are ordered by their scheduled date/time rather than recency
const SCHEDULED_VIEWS = ['appointment', 'follow_up'];

const DISPOSITION_LABELS = {
  appointment: 'Appointment',
  follow_up: 'Follow-Up',
  no: 'No',
  unqualified: 'Unqualified',
  customer: 'Customer'
};

// Which view a conversation belongs to. Every conversation resolves to
// exactly one, so nothing can fall into an unreachable state.
function getConversationBucket(conv) {
  if (conv.isLead) return 'storm-demo';

  // 1. Legal suppression always wins, and is shown distinctly from a
  //    business "No" so opt-outs are never buried among ordinary rejections.
  if (conv.opted_out) return 'opted_out';
  if (conv.wrong_number) return 'wrong_number';

  // 2. The human's decision.
  if (conv.disposition && DISPOSITION_LABELS[conv.disposition]) {
    return conv.disposition;
  }

  // 3. The automatic read of their reply.
  const hasResponded = conv.stage && conv.stage.endsWith('-Responded');
  if (!hasResponded) return 'pending';

  const cls = replyClassificationOf(conv);
  if (cls === CLS.NEGATIVE) return 'no';

  return 'new';
}

function getFolderForView(view) {
  return Object.keys(FOLDERS).find(f => FOLDERS[f].views.includes(view)) || 'new';
}

/** True when the contact may not be messaged at all. */
function isHardSuppressed(conv) {
  return Boolean(conv && (conv.opted_out || conv.wrong_number));
}

/** Short human label for a conversation's suppression state, or null. */
function suppressionLabelOf(conv) {
  if (!conv) return null;
  if (conv.opted_out) return 'Opted Out';
  if (conv.wrong_number) return 'Wrong Number';
  return null;
}

// Application State
let activeConversation = null;
let conversations = [];
let messages = [];
let ws = null;
let wsReconnectTimer = null;
let parsedLeads = []; // Phase 2: Parsed leads storage
let senderOptionsHtml = ''; // Rendered sender <option> markup, shared by every sender dropdown
let currentFolder = 'new'; // Sidebar folder (new/hot/customer/closed/pending/storm-demo)
let currentView = 'new';   // Active view within that folder
let pendingDisposition = null; // Disposition awaiting a date/time from the schedule modal
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
        
        currentFolder = 'storm-demo';
        currentView = 'storm-demo';

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
  setupStatsPanel();
  setupReminders();
  
  // Set webhook URL based on current host
  const host = window.location.host;
  const protocol = window.location.protocol;
  webhookUrlDisplay.textContent = `${protocol}//${host}/webhook/inbound`;

  // Event Listeners
  searchInput.addEventListener('input', filterConversations);

  // Inbox tab click handlers
  document.querySelectorAll('.folder-tab').forEach(tab => {
    tab.addEventListener('click', () => setActiveFolder(tab.dataset.folder));
  });
  document.querySelectorAll('.subtab').forEach(tab => {
    tab.addEventListener('click', () => setActiveView(tab.dataset.view));
  });

  // Sync the nav with the starting folder (storm-demo when leads were just imported)
  setActiveFolder(currentFolder, currentView);

  // Clear storm leads button handler
  const btnClearStormLeads = document.getElementById('btn-clear-storm-leads');
  if (btnClearStormLeads) {
    btnClearStormLeads.addEventListener('click', () => {
      if (confirm("Are you sure you want to clear all imported demo leads?")) {
        localStorage.removeItem('storm_map_imported_leads');
        localStorage.removeItem('storm_map_imported_county');
        localStorage.removeItem('storm_map_imported_state');
        updateStormLeadsBadge();
        if (currentView === 'storm-demo') {
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

  // Reset every secondary filter at once
  const btnResetFilters = document.getElementById('btn-reset-filters');
  if (btnResetFilters) {
    btnResetFilters.addEventListener('click', () => {
      filterFromDate.value = '';
      filterToDate.value = '';
      fromDate = '';
      toDate = '';
      currentStageFilter = 'all';
      document.querySelectorAll('.stage-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.stage === 'all');
      });
      searchInput.value = '';
      filterConversations();
    });
  }
  chatForm.addEventListener('submit', handleSendMessage);
  btnDeleteChat.addEventListener('click', handleDeleteActiveConversation);
  btnNewChat.addEventListener('click', () => newChatModal.classList.add('open'));
  modalClose.addEventListener('click', () => newChatModal.classList.remove('open'));
  newChatForm.addEventListener('submit', handleStartNewChat);
  
  // Close modal when clicking outside content
  newChatModal.addEventListener('click', (e) => {
    if (e.target === newChatModal) newChatModal.classList.remove('remove');
  });

  // Prospect Notes UI listeners
  const btnToggleNotes = document.getElementById('btn-toggle-notes');
  const btnToggleNotesHeader = document.getElementById('btn-toggle-notes-header');
  const btnFloatingNotes = document.getElementById('btn-floating-notes');
  const btnCloseNotes = document.getElementById('btn-close-notes');
  const notesAddForm = document.getElementById('notes-add-form');

  if (btnToggleNotes) btnToggleNotes.addEventListener('click', toggleNotesDrawer);
  if (btnToggleNotesHeader) btnToggleNotesHeader.addEventListener('click', toggleNotesDrawer);
  if (btnFloatingNotes) btnFloatingNotes.addEventListener('click', toggleNotesDrawer);
  if (btnCloseNotes) btnCloseNotes.addEventListener('click', closeNotesDrawer);
  if (notesAddForm) {
    notesAddForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const textarea = document.getElementById('note-input');
      if (textarea && textarea.value.trim()) {
        addNoteForActiveConversation(textarea.value);
        textarea.value = '';
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeNotesDrawer();
    }
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
    
    // Repopulate from the shared options so rotation stays the default.
    bulkSenderSelect.innerHTML = senderOptionsHtml;

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
        alert(`Success! Queued ${data.queued_count} bulk messages.` + skippedNote(data.skipped_count));
        
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

      // Repopulate from the shared options so rotation stays the default.
      campaignBulkSenderSelect.innerHTML = senderOptionsHtml;

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
          alert(`Success! Queued ${data.queued_count} campaign messages.` + skippedNote(data.skipped_count));
          
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

  // Disposition bar: one click for No/Unqualified/Customer, modal for the scheduled ones
  document.querySelectorAll('.dispo-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const disposition = btn.dataset.disposition;
      if (!activeConversation || activeConversation.isLead) return;

      if (disposition === 'appointment' || disposition === 'follow_up') {
        openScheduleModal(disposition);
        return;
      }

      // Clicking the disposition it already has clears it
      if (activeConversation.disposition === disposition) {
        await applyDisposition(null);
        return;
      }

      btn.disabled = true;
      await applyDisposition(disposition);
      btn.disabled = false;
    });
  });

  const btnClearDisposition = document.getElementById('btn-clear-disposition');
  if (btnClearDisposition) {
    btnClearDisposition.addEventListener('click', () => applyDisposition(null));
  }

  // Schedule modal
  const scheduleModal = document.getElementById('schedule-modal');
  const scheduleClose = document.getElementById('schedule-close');
  const scheduleForm = document.getElementById('schedule-form');
  const scheduleDatetime = document.getElementById('schedule-datetime');
  const scheduleNote = document.getElementById('schedule-note');
  const btnSaveSchedule = document.getElementById('btn-save-schedule');

  scheduleClose.addEventListener('click', () => scheduleModal.classList.remove('open'));
  scheduleModal.addEventListener('click', (e) => {
    if (e.target === scheduleModal) scheduleModal.classList.remove('open');
  });

  document.querySelectorAll('.quick-pick').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.quick-pick').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      scheduleDatetime.value = toLocalInputValue(resolveQuickPick(chip.dataset.offset));
    });
  });

  // Typing a custom time deselects the quick picks
  scheduleDatetime.addEventListener('input', () => {
    document.querySelectorAll('.quick-pick').forEach(c => c.classList.remove('active'));
  });

  scheduleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pendingDisposition || !scheduleDatetime.value) return;

    btnSaveSchedule.disabled = true;
    btnSaveSchedule.textContent = 'Saving...';

    // datetime-local is a LOCAL wall-clock value. Convert it to a real instant
    // so the server stores the correct UTC moment regardless of the user's zone.
    const scheduledAt = new Date(scheduleDatetime.value).toISOString();
    const saved = await applyDisposition(pendingDisposition, scheduledAt, scheduleNote.value.trim() || null);

    btnSaveSchedule.disabled = false;
    btnSaveSchedule.textContent = 'Save';

    if (saved) {
      scheduleModal.classList.remove('open');
      pendingDisposition = null;
    }
  });

  // Explicit re-opt-in. Requires a typed confirmation so it can never be a
  // stray click, and it is the ONLY way to lift an opt-out.
  const btnOptIn = document.getElementById('btn-opt-in');
  if (btnOptIn) {
    btnOptIn.addEventListener('click', async () => {
      if (!activeConversation || activeConversation.isLead) return;
      const name = activeConversation.name || activeConversation.phone_number;
      const confirmed = confirm(
        'Re-enable messaging for ' + name + '?\n\n' +
        'Only do this if the contact has asked to hear from you again. ' +
        'The re-opt-in is recorded against your username.'
      );
      if (!confirmed) return;

      try {
        const res = await fetch('/api/conversations/' + activeConversation.id + '/opt-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true })
        });
        if (!res.ok) {
          const err = await res.json();
          alert('Could not re-enable messaging: ' + (err.error || res.statusText));
          return;
        }
        const updated = await res.json();
        Object.assign(activeConversation, updated);
        updateSuppressionNotice(activeConversation);
        updateSentimentBadge(activeConversation);
        chatComposerContainer.style.display = 'block';
        await loadConversations();
      } catch (err) {
        console.error('Re-opt-in failed:', err);
        alert('Connection error.');
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

    // Reminders are derived from `conversations`. Without this the first check
    // could run before the list arrived, leaving a due appointment unflagged
    // until the next 60-second poll.
    if (typeof checkReminders === 'function' && remindersReady) {
      checkReminders();
    }

    // Keep the header badge in sync when a new reply changes the category
    if (activeConversation && !activeConversation.isLead) {
      const fresh = conversations.find(c => c.id === activeConversation.id);
      if (fresh) {
        Object.assign(activeConversation, fresh);
        updateSentimentBadge(fresh);
        updateDispositionBar(fresh);
        updateSuppressionNotice(fresh);
      }
    }
  } catch (err) {
    console.error("Error loading conversations:", err);
    conversationsList.innerHTML = `<div class="list-placeholder error">Failed to load chats</div>`;
  }
}

function formatDid(did) {
  const d = (did || '').replace(/[^\d]/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : did;
}

function updateSenderDropdowns(settings) {
  const bulkvsNumber = settings.sender_number || '+18887885527';

  // The DIDs cleared for sending, in rotation order.
  const pool = (settings.fractel_enabled_dids || '')
    .split(',')
    .map(d => d.trim().replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, ''))
    .filter(d => d.length === 10);

  const options = [];

  // Rotation is the default: spreads sends across the pool, but pins each
  // contact to one number so their thread always shows a single sender.
  if (pool.length) {
    options.push({
      value: 'rotate',
      label: `Rotate across all ${pool.length} numbers (recommended)`,
      selected: true
    });
  }

  // Individual numbers, for forcing a specific sender.
  pool.forEach(did => {
    options.push({ value: did, label: `FracTEL ${formatDid(did)}` });
  });

  // Add BulkVS as disabled/grayed out
  if (bulkvsNumber) {
    options.push({ value: bulkvsNumber, label: `BulkVS (${bulkvsNumber}) - Disabled`, disabled: true });
  }

  const renderOption = opt => {
    if (opt.disabled) {
      return `<option value="${opt.value}" disabled style="color: #666; background-color: #1a1d24;">${opt.label}</option>`;
    }
    return `<option value="${opt.value}"${opt.selected ? ' selected' : ''}>${opt.label}</option>`;
  };

  // Shared by every sender dropdown, including the ones the campaign and bulk
  // modals rebuild each time they open.
  senderOptionsHtml = options.map(renderOption).join('');

  [
    composerSenderSelect,
    campaignSenderSelect,
    campaignBulkSenderSelect,
    bulkSenderSelect,
    document.getElementById('test-sender')
  ].forEach(select => {
    if (select) select.innerHTML = senderOptionsHtml;
  });

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
    case 'conversation_disposition':
      handleIncomingDisposition(data);
      break;
  }
}

function handleIncomingConversationDeleted(data) {
  if (activeConversation && activeConversation.id === data.id) {
    resetChatToWelcomeBox();
  }
  loadConversations();
}

// Another browser tab (or user) dispositioned a lead
function handleIncomingDisposition(data) {
  const conv = conversations.find(c => c.id === data.id);
  if (conv) Object.assign(conv, data);

  if (activeConversation && activeConversation.id === data.id) {
    Object.assign(activeConversation, data);
    updateDispositionBar(activeConversation);
    updateSentimentBadge(activeConversation);
    updateSuppressionNotice(activeConversation);
  }
  renderConversations();
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

// Open a folder (and optionally a specific view inside it)
function setActiveFolder(folder, view = null) {
  if (!FOLDERS[folder]) return;

  currentFolder = folder;
  currentView = view && FOLDERS[folder].views.includes(view)
    ? view
    : FOLDERS[folder].views[0];

  document.querySelectorAll('.folder-tab').forEach(tab => {
    const isActive = tab.dataset.folder === folder;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // Show only the sub-tabs belonging to this folder
  const subtabRow = document.getElementById('subtab-row');
  const subtabs = document.querySelectorAll('.subtab');
  const hasSubtabs = FOLDERS[folder].views.length > 1;

  if (subtabRow) subtabRow.style.display = hasSubtabs ? 'flex' : 'none';
  subtabs.forEach(st => {
    st.style.display = st.dataset.parent === folder ? 'inline-flex' : 'none';
    st.classList.toggle('active', st.dataset.view === currentView);
  });

  filterConversations();
  toggleViewsBasedOnFilter();
}

// Switch view within the current folder
function setActiveView(view) {
  setActiveFolder(getFolderForView(view), view);
}

// Imported Storm Map / website demo leads, shaped like conversations
function getStormDemoLeads() {
  const leadsJson = localStorage.getItem('storm_map_imported_leads');
  const leads = leadsJson ? JSON.parse(leadsJson) : [];

  return leads.map((lead, index) => ({
    id: `lead-${index}`,
    phone_number: lead.phone,
    name: lead.name,
    isLead: true,
    leadData: lead,
    last_message_text: `${lead.stormType || 'Storm'} Lead · ${lead.confidence || 'High'} Conf`,
    last_message_at: lead.stormDate,
    unread: false
  }));
}

// Search + stage + date filters, applied regardless of which tab is open.
function applyBaseFilters(list) {
  const query = searchInput.value.toLowerCase().trim();

  return list.filter(c => {
    // 1. Search query filter
    const name = (c.name || '').toLowerCase();
    const phone = (c.phone_number || '').toLowerCase();
    if (query && !name.includes(query) && !phone.includes(query)) return false;

    // 2. Stage filter
    if (currentStageFilter !== 'all') {
      const stageBase = (c.stage || '').replace('-Responded', '');
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

function searchStormDemoLeads() {
  const query = searchInput.value.toLowerCase().trim();
  return getStormDemoLeads().filter(c => {
    const name = (c.name || '').toLowerCase();
    const phone = (c.phone_number || '').toLowerCase();
    return !query || name.includes(query) || phone.includes(query);
  });
}

function getFilteredConversations() {
  if (currentView === 'storm-demo') {
    return searchStormDemoLeads();
  }

  const list = applyBaseFilters(conversations)
    .filter(c => {
      const bucket = getConversationBucket(c);
      if (currentView === 'all_closed') {
        return ['no', 'unqualified', 'opted_out', 'wrong_number'].includes(bucket);
      }
      if (currentView === 'all_hot') {
        return ['appointment', 'follow_up'].includes(bucket);
      }
      return bucket === currentView;
    });

  // Appointments and follow-ups read as a schedule: soonest first
  if (SCHEDULED_VIEWS.includes(currentView)) {
    const at = c => {
      const d = c.scheduled_at ? parseUtc(c.scheduled_at) : null;
      return d ? d.getTime() : Infinity;
    };
    list.sort((a, b) => at(a) - at(b));
  }

  return list;
}

// Badge counts on every folder and sub-tab, honouring the search/stage/date filters.
function updateTabCounts() {
  const counts = {};
  ALL_VIEWS.forEach(v => { counts[v] = 0; });

  applyBaseFilters(conversations).forEach(c => {
    const bucket = getConversationBucket(c);
    if (bucket in counts) counts[bucket]++;
  });
  counts['storm-demo'] = searchStormDemoLeads().length;
  counts['all_closed'] = (counts['no'] || 0) + (counts['unqualified'] || 0) + (counts['opted_out'] || 0) + (counts['wrong_number'] || 0);
  counts['all_hot'] = (counts['appointment'] || 0) + (counts['follow_up'] || 0);

  // Sub-tab counts
  Object.entries(counts).forEach(([view, value]) => {
    const el = document.getElementById(`count-${view}`);
    if (!el) return;
    el.textContent = value;
    el.classList.toggle('is-zero', value === 0);
  });

  // Folder counts are the sum of their views (excluding synthetic 'all_*' views)
  Object.entries(FOLDERS).forEach(([folder, config]) => {
    const el = document.getElementById(`count-folder-${folder}`);
    if (!el) return;
    const total = config.views
      .filter(v => !v.startsWith('all_'))
      .reduce((sum, v) => sum + (counts[v] || 0), 0);
    el.textContent = total;
    el.classList.toggle('is-zero', total === 0);
  });
}

// Highlights the filter accordion when stage/date filters are narrowing the list.
function updateActiveFiltersBadge() {
  const badge = document.getElementById('filters-active-badge');
  const accordion = document.getElementById('filters-accordion');
  if (!badge || !accordion) return;

  let active = 0;
  if (currentStageFilter !== 'all') active++;
  if (fromDate) active++;
  if (toDate) active++;

  badge.textContent = active;
  badge.style.display = active > 0 ? 'inline-flex' : 'none';
  accordion.classList.toggle('has-active-filters', active > 0);
}

// Friendly empty-state copy for each tab
function getEmptyStateHtml() {
  const query = searchInput.value.trim();
  const hasNarrowingFilters = query || currentStageFilter !== 'all' || fromDate || toDate;

  if (hasNarrowingFilters) {
    return `
      <div class="list-empty">
        <div class="list-empty-title">No matches</div>
        <p>Nothing in this tab matches your current search or filters.</p>
      </div>`;
  }

  const copy = {
    'new': {
      title: 'Inbox zero',
      body: 'New positive replies land here. Disposition one and it moves out of this tab.'
    },
    appointment: {
      title: 'No appointments booked',
      body: 'Open a reply and hit “Set Appointment” to book one.'
    },
    follow_up: {
      title: 'No follow-ups scheduled',
      body: 'Open a reply and hit “Follow-Up” to schedule a callback.'
    },
    customer: {
      title: 'No customers yet',
      body: 'Mark a realtor as a customer once they sign up.'
    },
    'no': {
      title: 'No rejections',
      body: 'Leads who said no thanks. Legal opt-outs are kept separately under Opted Out.'
    },
    unqualified: {
      title: 'Nothing unqualified',
      body: 'Leads you mark as not a fit show up here.'
    },
    opted_out: {
      title: 'No opt-outs',
      body: 'Contacts who sent STOP or another legal opt-out. They can never be messaged again unless you explicitly re-enable them.'
    },
    wrong_number: {
      title: 'No wrong numbers',
      body: 'Numbers that reached the wrong person are parked here and excluded from every send.'
    },
    pending: {
      title: 'Nothing pending',
      body: 'Contacts you have messaged who have not replied yet appear here.'
    },
    'storm-demo': {
      title: 'No web form leads',
      body: 'Run a scan in the Storm Map app and click “Send Leads to SMS App”.'
    }
  }[currentView] || { title: 'Nothing here', body: '' };

  return `
    <div class="list-empty">
      <div class="list-empty-title">${copy.title}</div>
      <p>${copy.body}</p>
    </div>`;
}

// 5. Render Sidebar conversations
function renderConversations() {
  const convListHeader = document.getElementById('conv-list-header');

  updateTabCounts();
  updateActiveFiltersBadge();

  conversationsList.innerHTML = '';

  const filtered = getFilteredConversations();

  // Update selection header (bulk actions do not apply to un-imported leads)
  if (convListHeader) {
    if (filtered.length > 0 && currentView !== 'storm-demo') {
      convListHeader.style.display = 'flex';
      document.getElementById('visible-convs-count').textContent = filtered.length;
    } else {
      convListHeader.style.display = 'none';
    }
  }

  if (filtered.length === 0) {
    conversationsList.innerHTML = getEmptyStateHtml();
    updateBulkActionBarUI(filtered);
    return;
  }

  filtered.forEach(c => {
    const isActive = activeConversation && activeConversation.id === c.id;
    const bucket = c.isLead ? 'storm-demo' : getConversationBucket(c);
    const item = document.createElement('div');
    item.className = `conversation-item bucket-${bucket} ${isActive ? 'active' : ''}`;
    item.dataset.id = c.id;

    const initials = c.name ? c.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase() : '#';
    const displayName = c.name || c.phone_number;

    // Format timestamp
    let timeStr = '';
    if (c.last_message_at) {
      timeStr = formatMessageTimestamp(c.last_message_at);
    }

    const isUnread = c.unread === 1 || c.unread === '1' || c.unread === true;
    const repliedDot = isUnread && (!activeConversation || activeConversation.id !== c.id) ? `<span class="conv-replied-dot" title="New reply"></span>` : '';
    const isChecked = selectedConversations.has(c.id);

    // Scheduled views read as a diary; everything else shows the contact's reply
    const isScheduled = SCHEDULED_VIEWS.includes(bucket) && c.scheduled_at;
    const showsReply = !isScheduled && bucket !== 'pending' && !c.isLead && c.last_inbound_text;

    let preview;
    let previewIcon = '';
    let overdueClass = '';

    if (isScheduled) {
      const due = parseUtc(c.scheduled_at);
      const isOverdue = due && due.getTime() < Date.now();
      overdueClass = isOverdue ? ' is-overdue' : '';
      preview = `${isOverdue ? 'Overdue · ' : ''}${formatScheduleTimestamp(due)}`;
      previewIcon = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="conv-schedule-icon"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;
    } else if (showsReply) {
      preview = c.last_inbound_text;
      previewIcon = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="conv-reply-icon"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>`;
    } else {
      preview = c.last_message_text || 'No messages';
    }

    // Stage chip (Stage 1/2/3) so the follow-up depth is visible at a glance
    const stageBase = (c.stage || '').replace('-Responded', '');
    const stageChip = !c.isLead && stageBase
      ? `<span class="conv-stage-chip" title="Follow-up ${stageBase}">${stageBase.replace('Stage ', 'S')}</span>`
      : '';

    const checkboxHtml = c.isLead ? '' : `
      <label class="conv-checkbox-container" onclick="event.stopPropagation()">
        <input type="checkbox" class="conv-select-checkbox" data-id="${c.id}" ${isChecked ? 'checked' : ''}>
        <span class="checkbox-custom"></span>
      </label>`;

    const stateBadge = renderStateBadge(c.phone_number, true);

    item.innerHTML = `
      ${checkboxHtml}
      <div class="avatar">${initials}</div>
      <div class="conv-details">
        <div class="conv-meta">
          <span class="conv-name">${escapeHTML(displayName)}${repliedDot}</span>
          <div class="conv-meta-right">
            ${stateBadge}
            <span class="conv-time">${timeStr}</span>
          </div>
        </div>
        <div class="conv-preview${overdueClass}">${previewIcon}<span class="conv-preview-text">${escapeHTML(preview)}</span>${stageChip}</div>
      </div>
    `;

    // Handle checkbox change
    const checkbox = item.querySelector('.conv-select-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectedConversations.add(c.id);
        } else {
          selectedConversations.delete(c.id);
        }
        updateBulkActionBarUI(filtered);
      });
    }

    item.addEventListener('click', () => selectConversation(c));
    conversationsList.appendChild(item);
  });

  updateBulkActionBarUI(filtered);
}

function filterConversations() {
  clearSelection();
  renderConversations();
}

/* ------------------------------------------------------------------
 * Dispositions
 * ------------------------------------------------------------------ */

// "Aug 5, 2:00 PM" — used for appointment/follow-up times
function formatScheduleTimestamp(dateInput) {
  if (!dateInput) return '';
  const date = dateInput instanceof Date ? dateInput : parseUtc(dateInput) || new Date(dateInput);
  if (!date || isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

// Local date/time formatted for a datetime-local input and for SQLite storage
function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Refreshes the disposition bar for the active conversation
function updateDispositionBar(conv) {
  const bar = document.getElementById('disposition-bar');
  const current = document.getElementById('disposition-current');
  const chip = document.getElementById('disposition-chip');
  if (!bar) return;

  // Un-imported leads have no conversation record to disposition yet
  if (!conv || conv.isLead) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';

  document.querySelectorAll('.dispo-btn').forEach(btn => {
    btn.classList.toggle('is-set', btn.dataset.disposition === conv.disposition);
  });

  if (conv.disposition && DISPOSITION_LABELS[conv.disposition]) {
    let text = DISPOSITION_LABELS[conv.disposition];
    if (conv.scheduled_at) text += ` · ${formatScheduleTimestamp(conv.scheduled_at)}`;
    chip.textContent = text;
    chip.className = `disposition-chip dispo-${conv.disposition}`;
    current.style.display = 'flex';
  } else {
    current.style.display = 'none';
  }
}

// Sends the disposition to the server and refreshes the UI
async function applyDisposition(disposition, scheduledAt = null, note = null) {
  if (!activeConversation || activeConversation.isLead) return false;

  try {
    const res = await fetch(`/api/conversations/${activeConversation.id}/disposition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disposition, scheduled_at: scheduledAt, note })
    });

    if (!res.ok) {
      const err = await res.json();
      alert('Could not save disposition: ' + (err.error || res.statusText));
      return false;
    }

    const updated = await res.json();
    Object.assign(activeConversation, updated);
    updateDispositionBar(activeConversation);
    updateSentimentBadge(activeConversation);
    updateSuppressionNotice(activeConversation);
    await loadConversations();
    return true;
  } catch (err) {
    console.error('Disposition error:', err);
    alert('Connection error saving disposition.');
    return false;
  }
}

// Opens the date/time modal for the two scheduled dispositions
function openScheduleModal(disposition) {
  if (!activeConversation) return;

  pendingDisposition = disposition;

  const modal = document.getElementById('schedule-modal');
  const title = document.getElementById('schedule-modal-title');
  const contact = document.getElementById('schedule-contact');
  const input = document.getElementById('schedule-datetime');
  const note = document.getElementById('schedule-note');

  title.textContent = disposition === 'appointment' ? 'Set Appointment' : 'Schedule Follow-Up';
  contact.textContent = `${activeConversation.name || activeConversation.phone_number} · ${activeConversation.phone_number}`;

  // Reuse the existing time when re-scheduling, otherwise pick a sensible default
  if (activeConversation.disposition === disposition && activeConversation.scheduled_at) {
    input.value = toLocalInputValue(parseUtc(activeConversation.scheduled_at));
  } else {
    const preset = new Date();
    preset.setDate(preset.getDate() + (disposition === 'appointment' ? 1 : 3));
    preset.setHours(10, 0, 0, 0);
    input.value = toLocalInputValue(preset);
  }

  note.value = activeConversation.disposition_note || '';
  document.querySelectorAll('.quick-pick').forEach(q => q.classList.remove('active'));
  modal.classList.add('open');
}

// Turns a quick-pick chip into a concrete date/time
function resolveQuickPick(offset) {
  const date = new Date();
  if (offset === '2h') {
    date.setHours(date.getHours() + 2, 0, 0, 0);
  } else if (offset === 'tomorrow') {
    date.setDate(date.getDate() + 1);
    date.setHours(10, 0, 0, 0);
  } else if (offset === '2d') {
    date.setDate(date.getDate() + 2);
    date.setHours(10, 0, 0, 0);
  } else if (offset === '7d') {
    date.setDate(date.getDate() + 7);
    date.setHours(10, 0, 0, 0);
  }
  return date;
}

// Shows Positive / Negative / Awaiting reply next to the contact name
function updateSentimentBadge(conv) {
  const badge = document.getElementById('active-sentiment-badge');
  if (!badge) return;

  if (!conv || conv.isLead) {
    badge.style.display = 'none';
    return;
  }

  // Describes the contact's REPLY, independent of any business disposition.
  // A plain "No thanks" must never be labelled "Opted out".
  let tone;
  let label;

  if (conv.opted_out) {
    tone = 'opted-out';
    label = 'Opted Out';
  } else if (conv.wrong_number) {
    tone = 'wrong-number';
    label = 'Wrong Number';
  } else {
    const hasResponded = conv.stage && conv.stage.endsWith('-Responded');
    if (!hasResponded) {
      tone = 'pending';
      label = 'Awaiting Reply';
    } else {
      const cls = replyClassificationOf(conv) || CLS.POSITIVE;
      tone = {
        [CLS.POSITIVE]: 'positive',
        [CLS.NEGATIVE]: 'negative',
        [CLS.OPT_OUT]: 'opted-out',
        [CLS.WRONG_NUMBER]: 'wrong-number',
        [CLS.UNKNOWN]: 'unknown'
      }[cls];
      label = Classify.labelFor(cls);
    }
  }

  badge.textContent = label;
  badge.className = `sentiment-badge ${tone}`;
  badge.style.display = 'inline-flex';
}

/**
 * Swaps the composer for a suppression notice. Individual sends to a
 * hard-suppressed contact are refused by the server too — this stops the
 * user wasting a click, it is not the enforcement.
 */
function updateSuppressionNotice(conv) {
  const notice = document.getElementById('suppressed-notice');
  const composer = document.getElementById('chat-composer-container');
  if (!notice) return;

  if (!conv || conv.isLead || !isHardSuppressed(conv)) {
    notice.style.display = 'none';
    return;
  }

  const title = document.getElementById('suppressed-title');
  const detail = document.getElementById('suppressed-detail');

  if (conv.opted_out) {
    title.textContent = 'This contact opted out';
    const when = conv.opted_out_at ? formatScheduleTimestamp(conv.opted_out_at) : 'an earlier message';
    const quote = conv.opt_out_text ? ` They said: “${conv.opt_out_text}”.` : '';
    detail.textContent = `Recorded ${when} via ${conv.opt_out_source || 'an inbound reply'}.${quote} Messaging is blocked.`;
  } else {
    title.textContent = 'Wrong number';
    detail.textContent = 'This number reached the wrong person, so messaging is blocked.';
  }

  notice.style.display = 'flex';
  if (composer) composer.style.display = 'none';
}

const AREA_CODE_MAP_INLINE = {
  "201": "NJ", "202": "DC", "203": "CT", "205": "AL", "206": "WA", "207": "ME", "208": "ID", "209": "CA",
  "210": "TX", "212": "NY", "213": "CA", "214": "TX", "215": "PA", "216": "OH", "217": "IL", "218": "MN",
  "219": "IN", "220": "OH", "223": "PA", "224": "IL", "225": "LA", "227": "MD", "228": "MS", "229": "GA",
  "231": "MI", "234": "OH", "236": "VA", "239": "FL", "240": "MD", "248": "MI", "249": "MD", "251": "AL",
  "252": "NC", "253": "WA", "254": "TX", "256": "AL", "257": "CA", "260": "IN", "262": "WI", "267": "PA",
  "269": "MI", "270": "KY", "272": "PA", "276": "VA", "279": "CA", "281": "TX", "301": "MD", "302": "DE",
  "303": "CO", "304": "WV", "305": "FL", "307": "WY", "308": "NE", "309": "IL", "310": "CA", "312": "IL",
  "313": "MI", "314": "MO", "315": "NY", "316": "KS", "317": "IN", "318": "LA", "319": "IA", "320": "MN",
  "321": "FL", "323": "CA", "325": "TX", "326": "OH", "330": "OH", "331": "IL", "332": "NY", "334": "AL",
  "336": "NC", "337": "LA", "339": "MA", "341": "CA", "346": "TX", "347": "NY", "351": "MA", "352": "FL",
  "360": "WA", "361": "TX", "364": "KY", "380": "OH", "385": "UT", "386": "FL", "401": "RI", "402": "NE",
  "404": "GA", "405": "OK", "406": "MT", "407": "FL", "408": "CA", "409": "TX", "410": "MD", "412": "PA",
  "413": "MA", "414": "WI", "415": "CA", "417": "MO", "419": "OH", "423": "TN", "424": "CA", "425": "WA",
  "430": "TX", "432": "TX", "434": "VA", "435": "UT", "440": "OH", "442": "CA", "443": "MD", "458": "OR",
  "463": "IN", "469": "TX", "470": "GA", "475": "CT", "478": "GA", "479": "AR", "480": "AZ", "484": "PA",
  "501": "AR", "502": "KY", "503": "OR", "504": "LA", "505": "NM", "507": "MN", "508": "MA", "509": "WA",
  "510": "CA", "512": "TX", "513": "OH", "515": "IA", "516": "NY", "517": "MI", "518": "NY", "520": "AZ",
  "530": "CA", "531": "NE", "534": "WI", "539": "OK", "540": "VA", "541": "OR", "551": "NJ", "559": "CA",
  "561": "FL", "562": "CA", "563": "IA", "567": "OH", "570": "PA", "571": "VA", "573": "MO", "574": "IN",
  "575": "NM", "580": "OK", "585": "NY", "586": "MI", "601": "MS", "602": "AZ", "603": "NH", "605": "SD",
  "606": "KY", "607": "NY", "608": "WI", "609": "NJ", "610": "PA", "612": "MN", "614": "OH", "615": "TN",
  "616": "MI", "617": "MA", "618": "IL", "619": "CA", "620": "KS", "623": "AZ", "626": "CA", "628": "CA",
  "629": "TN", "630": "IL", "631": "NY", "636": "MO", "641": "IA", "646": "NY", "650": "CA", "651": "MN",
  "657": "CA", "660": "MO", "661": "CA", "662": "MS", "667": "MD", "669": "CA", "678": "GA", "681": "WV",
  "682": "TX", "701": "ND", "702": "NV", "703": "VA", "704": "NC", "706": "GA", "707": "CA", "708": "IL",
  "712": "IA", "713": "TX", "714": "CA", "715": "WI", "716": "NY", "717": "PA", "718": "NY", "719": "CO",
  "720": "CO", "724": "PA", "725": "NV", "727": "FL", "731": "TN", "732": "NJ", "734": "MI", "737": "TX",
  "740": "OH", "747": "CA", "754": "FL", "757": "VA", "760": "CA", "762": "GA", "763": "MN", "765": "IN",
  "769": "MS", "770": "GA", "772": "FL", "773": "IL", "774": "MA", "775": "NV", "779": "IL", "781": "MA",
  "785": "KS", "786": "FL", "787": "PR", "801": "UT", "802": "VT", "803": "SC", "804": "VA", "805": "CA",
  "806": "TX", "808": "HI", "810": "MI", "812": "IN", "813": "FL", "814": "PA", "815": "IL", "816": "MO",
  "817": "TX", "818": "CA", "828": "NC", "830": "TX", "831": "CA", "832": "TX", "843": "SC", "845": "NY",
  "847": "IL", "848": "NJ", "850": "FL", "854": "SC", "856": "NJ", "857": "MA", "858": "CA", "859": "KY",
  "860": "CT", "862": "NJ", "863": "FL", "864": "SC", "865": "TN", "870": "AR", "878": "PA", "901": "TN",
  "903": "TX", "904": "FL", "906": "MI", "907": "AK", "908": "NJ", "909": "CA", "910": "NC", "912": "GA",
  "913": "KS", "914": "NY", "915": "TX", "916": "CA", "917": "NY", "918": "OK", "919": "NC", "920": "WI",
  "925": "CA", "928": "AZ", "929": "NY", "931": "TN", "936": "TX", "937": "OH", "940": "TX", "941": "FL",
  "947": "MI", "949": "CA", "951": "CA", "952": "MN", "954": "FL", "956": "TX", "970": "CO", "971": "OR",
  "972": "TX", "973": "NJ", "978": "MA", "979": "TX", "980": "NC", "984": "NC", "985": "LA", "989": "MI"
};

function getStateFromPhoneInline(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  let code = null;
  if (digits.length === 10) code = digits.slice(0, 3);
  else if (digits.length >= 11 && digits.startsWith('1')) code = digits.slice(1, 4);
  else if (digits.length >= 3) code = digits.slice(0, 3);
  return code ? (AREA_CODE_MAP_INLINE[code] || null) : null;
}

function renderStateBadge(phone, isSidebar = false) {
  if (!phone) return '';
  const state = getStateFromPhoneInline(phone) || (window.AreaCodes ? window.AreaCodes.getStateFromPhone(phone) : null);
  if (!state) return '';
  if (isSidebar) {
    return `<span class="prospect-state-badge sidebar-state-badge" title="State for area code ${window.AreaCodes ? window.AreaCodes.extractAreaCode(phone) : ''}">${escapeHTML(state)}</span>`;
  }
  return `<span class="prospect-state-badge" style="display: inline-flex !important; align-items: center !important; justify-content: center !important; background: #2563eb !important; color: #ffffff !important; font-size: 11px !important; font-weight: 700 !important; padding: 1px 6px !important; border-radius: 4px !important; margin-left: 6px !important; vertical-align: middle !important; letter-spacing: 0.5px !important;" title="State for area code">${escapeHTML(state)}</span>`;
}

// 6. Select active chat
async function selectConversation(conv) {
  activeConversation = conv;
  updateSentimentBadge(conv);
  updateDispositionBar(conv);
  updateSuppressionNotice(conv);

  const btnToggleNotes = document.getElementById('btn-toggle-notes');
  if (btnToggleNotes) btnToggleNotes.style.display = 'inline-flex';

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
    messagesFeed.style.display = 'flex';
    chatComposerContainer.style.display = 'block';
    
    // Setup Chat Header
    const initials = conv.name ? conv.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase() : '#';
    const stateBadge = renderStateBadge(conv.phone_number);
    activeAvatar.textContent = initials;
    activeContactName.innerHTML = `${escapeHTML(conv.name || conv.phone_number)}`;
    activeContactPhone.innerHTML = `<span style="font-weight:600;">${escapeHTML(conv.phone_number)}</span> ${stateBadge} · Demo Lead`;
    
    btnDeleteChat.style.display = 'none';
    loadNotesForActiveConversation();
    
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
              <h3 style="font-family: var(--font-heading); font-size: 15px; color: var(--text-main); margin: 0;">${conv.name} ${stateBadge}</h3>
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
  const phoneStr = conv.phone_number || '';
  const stateBadge = renderStateBadge(phoneStr);

  activeAvatar.textContent = initials;
  activeContactName.innerHTML = `${escapeHTML(conv.name || phoneStr)}`;
  activeContactPhone.innerHTML = `<span style="font-weight:600;">${escapeHTML(phoneStr)}</span> ${stateBadge}`;
  
  // Show the composer only when the contact may actually be messaged.
  // updateSuppressionNotice hides it, and this used to override that.
  chatComposerContainer.style.display = isHardSuppressed(conv) ? 'none' : 'block';
  btnDeleteChat.style.display = 'block';
  updateCharCounter(messageInput, chatCharCounter);
  
  // Load notes for active prospect
  loadNotesForActiveConversation();

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

  // Format time using parseUtc
  const timeStr = formatMessageTimestamp(msg.created_at || msg.sent_at);

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
        setActiveFolder('pending');
        setTimeout(async () => {
          await loadConversations();
          const newConv = conversations.find(c => c.id === convId);
          if (newConv) {
            selectConversation(newConv);
          }
        }, 300);
      }
    } else if (res.status === 409) {
      const err = await res.json();
      alert(err.error || 'This contact is suppressed and cannot be messaged.');
      // Re-sync so the composer is replaced by the suppression notice.
      await loadConversations();
      const fresh = conversations.find(c => c.id === convId);
      if (fresh) {
        Object.assign(activeConversation, fresh);
        updateSuppressionNotice(fresh);
        updateSentimentBadge(fresh);
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
  updateSentimentBadge(null);
  updateDispositionBar(null);
  updateSuppressionNotice(null);

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

/* ==================================================================
 * Appointment and follow-up reminders
 *
 * Times arrive from the server as UTC 'YYYY-MM-DD HH:MM:SS'. They are
 * parsed as UTC and rendered in the viewer's local timezone.
 *
 * Reminder state is persisted server-side (reminder_state table) so a
 * reminder fires once per tier and survives refreshes and restarts.
 * No external SMS or email reminders are sent — this is in-app plus
 * optional browser notifications only.
 * ================================================================== */

// Tiers, most urgent first. A scheduled item fires at most once per tier.
const REMINDER_TIERS = [
  { id: 'overdue',  label: 'Overdue',  test: mins => mins < 0 },
  { id: 'due_now',  label: 'Due now',  test: mins => mins >= 0 && mins <= 5 },
  { id: 'due_15',   label: 'In 15 minutes', test: mins => mins > 5 && mins <= 15 },
  { id: 'due_60',   label: 'In 1 hour', test: mins => mins > 15 && mins <= 60 }
];

const REMINDER_POLL_MS = 60000;
let reminderTimer = null;

function getEstOffsetString(dateStr) {
  const month = dateStr ? parseInt(dateStr.slice(5, 7), 10) : 8;
  return (month >= 3 && month <= 11) ? '-04:00' : '-05:00';
}

function parseUtc(stamp) {
  if (!stamp) return null;
  if (stamp instanceof Date) return isNaN(stamp.getTime()) ? null : stamp;
  if (typeof stamp === 'number') return new Date(stamp);
  let str = String(stamp).trim();
  if (!str) return null;
  str = str.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(str)) {
    str += 'Z';
  }
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

/** Minutes until a scheduled time. Negative means overdue. */
function minutesUntil(stamp) {
  const date = parseUtc(stamp);
  if (!date) return null;
  return (date.getTime() - Date.now()) / 60000;
}

function reminderTierFor(stamp) {
  const mins = minutesUntil(stamp);
  if (mins === null) return null;
  return REMINDER_TIERS.find(t => t.test(mins)) || null;
}

/** Scheduled conversations that need attention now, soonest first. */
function getDueReminders() {
  return conversations
    .filter(c => SCHEDULED_VIEWS.includes(c.disposition) && c.scheduled_at && !isHardSuppressed(c))
    .map(c => ({ conv: c, tier: reminderTierFor(c.scheduled_at), mins: minutesUntil(c.scheduled_at) }))
    .filter(r => r.tier)
    .sort((a, b) => a.mins - b.mins);
}

/** Counts shown on the Hot Leads folder. */
function getReminderCounts() {
  let overdue = 0;
  let dueSoon = 0;
  getDueReminders().forEach(r => {
    if (r.tier.id === 'overdue') overdue++;
    else dueSoon++;
  });
  return { overdue, dueSoon };
}

function updateHotLeadsIndicator() {
  const tab = document.querySelector('.folder-tab[data-folder="hot"]');
  if (!tab) return;
  const { overdue, dueSoon } = getReminderCounts();

  tab.classList.toggle('has-overdue', overdue > 0);
  tab.classList.toggle('has-due-soon', overdue === 0 && dueSoon > 0);

  let pip = tab.querySelector('.tab-alert');
  if (overdue + dueSoon > 0) {
    if (!pip) {
      pip = document.createElement('span');
      pip.className = 'tab-alert';
      tab.appendChild(pip);
    }
    pip.textContent = overdue > 0 ? String(overdue) : String(dueSoon);
    pip.title = overdue > 0
      ? `${overdue} overdue`
      : `${dueSoon} due soon`;
  } else if (pip) {
    pip.remove();
  }
}

/** Ask the server which reminders have already been delivered. */
async function fetchNotifiedReminders() {
  try {
    const res = await fetch('/api/reminders');
    if (!res.ok) return { due: [], notified: [] };
    return await res.json();
  } catch (err) {
    console.error('Reminder fetch failed:', err);
    return { due: [], notified: [] };
  }
}

/** Mark a reminder tier as delivered so it never fires twice. */
async function acknowledgeReminder(conversationId, scheduledAt, tier) {
  try {
    await fetch('/api/reminders/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, scheduled_at: scheduledAt, tier })
    });
  } catch (err) {
    console.error('Reminder ack failed:', err);
  }
}

function reminderKey(conversationId, scheduledAt, tier) {
  return `${conversationId}|${scheduledAt}|${tier}`;
}

/** The in-app reminder banner. Not dependent on notification permission. */
function renderReminderBanner(due) {
  const banner = document.getElementById('reminder-banner');
  const list = document.getElementById('reminder-list');
  const count = document.getElementById('reminder-count');
  const drawer = document.getElementById('notes-drawer');
  if (!banner || !list) return;

  const isNotesOpen = (drawer && drawer.style.display !== 'none') || document.body.classList.contains('notes-open');

  if (!due.length || isNotesOpen) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  count.textContent = String(due.length);
  list.innerHTML = due.slice(0, 6).map(r => {
    const name = r.conv.name || r.conv.phone_number;
    const when = formatScheduleTimestamp(r.conv.scheduled_at);
    const kind = r.conv.disposition === 'appointment' ? 'Appointment' : 'Follow-up';
    return `
      <button type="button" class="reminder-item tier-${r.tier.id}" data-conversation-id="${escapeHTML(r.conv.id)}">
        <span class="reminder-tier">${escapeHTML(r.tier.label)}</span>
        <span class="reminder-name">${escapeHTML(name)}</span>
        <span class="reminder-meta">${escapeHTML(kind)} &middot; ${escapeHTML(when)}</span>
      </button>`;
  }).join('');

  list.querySelectorAll('.reminder-item').forEach(item => {
    item.addEventListener('click', () => {
      const conv = conversations.find(c => String(c.id) === item.dataset.conversationId);
      if (conv) {
        setActiveFolder(getFolderForView(getConversationBucket(conv)),
                        getConversationBucket(conv));
        selectConversation(conv);
      }
    });
  });
}

/** Browser notification, only with permission and only once per tier. */
function sendBrowserNotification(reminder) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const name = reminder.conv.name || reminder.conv.phone_number;
  const kind = reminder.conv.disposition === 'appointment' ? 'Appointment' : 'Follow-up';
  try {
    new Notification(`${reminder.tier.label}: ${kind}`, {
      body: `${name} — ${formatScheduleTimestamp(reminder.conv.scheduled_at)}`,
      tag: reminderKey(reminder.conv.id, reminder.conv.scheduled_at, reminder.tier.id)
    });
  } catch (err) {
    console.error('Notification failed:', err);
  }
}

let notifiedKeys = new Set();
let remindersReady = false;

async function checkReminders() {
  const due = getDueReminders();
  renderReminderBanner(due);
  updateHotLeadsIndicator();

  for (const reminder of due) {
    const key = reminderKey(reminder.conv.id, reminder.conv.scheduled_at, reminder.tier.id);
    if (notifiedKeys.has(key)) continue;
    notifiedKeys.add(key);
    sendBrowserNotification(reminder);
    await acknowledgeReminder(reminder.conv.id, reminder.conv.scheduled_at, reminder.tier.id);
  }
}

async function setupReminders() {
  // Seed from the server so a refresh does not replay old reminders.
  const state = await fetchNotifiedReminders();
  notifiedKeys = new Set((state.notified || []).map(r =>
    reminderKey(r.conversation_id, r.scheduled_at, r.tier)));

  const dismiss = document.getElementById('reminder-dismiss');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      const banner = document.getElementById('reminder-banner');
      if (banner) banner.style.display = 'none';
    });
  }

  const enable = document.getElementById('reminder-enable-notifications');
  if (enable) {
    const sync = () => {
      const supported = 'Notification' in window;
      enable.style.display = supported && Notification.permission === 'default' ? 'inline-flex' : 'none';
    };
    enable.addEventListener('click', async () => {
      if ('Notification' in window) {
        await Notification.requestPermission();
        sync();
      }
    });
    sync();
  }

  remindersReady = true;
  checkReminders();
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(checkReminders, REMINDER_POLL_MS);
}

/* ==================================================================
 * Performance Stats
 * ================================================================== */

function toDateInputValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Resolves a preset key to a [from, to] pair of YYYY-MM-DD strings.
// Weeks start on Monday.
function resolveDatePreset(preset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startOfWeek = (ref) => {
    const d = new Date(ref);
    const dayOfWeek = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dayOfWeek);
    return d;
  };
  const shift = (ref, days) => {
    const d = new Date(ref);
    d.setDate(d.getDate() + days);
    return d;
  };

  let from, to;
  switch (preset) {
    case 'today':
      from = to = today;
      break;
    case 'yesterday':
      from = to = shift(today, -1);
      break;
    case 'this-week':
      from = startOfWeek(today);
      to = today;
      break;
    case 'last-week':
      from = shift(startOfWeek(today), -7);
      to = shift(from, 6);
      break;
    case 'last-30':
      from = shift(today, -29);
      to = today;
      break;
    case 'this-month':
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      to = today;
      break;
    case 'last-month':
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      to = new Date(today.getFullYear(), today.getMonth(), 0); // day 0 = last day of previous month
      break;
    case 'this-year':
      from = new Date(today.getFullYear(), 0, 1);
      to = today;
      break;
    case 'last-year':
      from = new Date(today.getFullYear() - 1, 0, 1);
      to = new Date(today.getFullYear() - 1, 11, 31);
      break;
    default:
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      to = today;
  }

  return [toDateInputValue(from), toDateInputValue(to)];
}

// "Jul 1 – Jul 31, 2026", collapsing to a single date when the range is one day
function formatRangeLabel(from, to) {
  const parse = s => new Date(s + 'T00:00:00');
  const fromDate = parse(from);
  const toDate = parse(to);
  const opts = { month: 'short', day: 'numeric' };

  if (from === to) {
    return fromDate.toLocaleDateString([], { ...opts, year: 'numeric' });
  }
  const sameYear = fromDate.getFullYear() === toDate.getFullYear();
  const left = fromDate.toLocaleDateString([], sameYear ? opts : { ...opts, year: 'numeric' });
  const right = toDate.toLocaleDateString([], { ...opts, year: 'numeric' });
  return `${left} – ${right}`;
}

function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours * 10) / 10} hr`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

function formatHour(hour) {
  if (hour === null || hour === undefined) return '—';
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display} ${suffix}`;
}

// Collapses the daily series into at most ~30 buckets so a full year stays readable
function bucketDailySeries(daily, from, to) {
  const spanDays = Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
  const byDay = {};
  daily.forEach(d => { byDay[d.day] = d; });

  // Fill gaps so quiet days still occupy space on the axis
  const filled = [];
  const cursor = new Date(from + 'T00:00:00');
  for (let i = 0; i < spanDays; i++) {
    const key = toDateInputValue(cursor);
    const row = byDay[key];
    filled.push({ day: key, sent: row ? row.sent : 0, replies: row ? row.replies : 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  let unit = 'day';
  if (spanDays > 210) unit = 'month';
  else if (spanDays > 45) unit = 'week';

  if (unit === 'day') {
    return { unit, buckets: filled.map(d => ({ label: d.day, sent: d.sent, replies: d.replies })) };
  }

  // Group on real calendar boundaries so the axis labels mean what they say
  const groups = new Map();
  filled.forEach(d => {
    let key;
    if (unit === 'month') {
      key = d.day.slice(0, 7) + '-01';
    } else {
      const date = new Date(d.day + 'T00:00:00');
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); // back to Monday
      key = toDateInputValue(date);
    }
    if (!groups.has(key)) groups.set(key, { label: key, sent: 0, replies: 0 });
    const bucket = groups.get(key);
    bucket.sent += d.sent;
    bucket.replies += d.replies;
  });

  return { unit, buckets: Array.from(groups.values()) };
}

// Hand-rolled SVG bar chart — no external charting dependency.
// Drawn in real pixel units so labels are never distorted by scaling.
let lastChartData = null;

function renderStatsChart(daily, from, to) {
  const container = document.getElementById('stats-chart');
  if (!container) return;

  lastChartData = { daily, from, to };

  const { unit, buckets } = bucketDailySeries(daily, from, to);

  if (buckets.every(b => b.sent === 0 && b.replies === 0)) {
    container.innerHTML = `<div class="chart-empty">No messages in this period.</div>`;
    return;
  }

  const width = Math.max(320, container.clientWidth);
  const height = Math.max(160, container.clientHeight);
  const padLeft = 34;
  const padRight = 6;
  const padTop = 8;
  const padBottom = 22;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const baseline = padTop + plotHeight;

  const max = Math.max(1, ...buckets.map(b => Math.max(b.sent, b.replies)));
  const slot = plotWidth / buckets.length;
  const barWidth = Math.max(2, Math.min(18, slot * 0.36));

  const labelFor = (label) => {
    const d = new Date(label + 'T00:00:00');
    if (unit === 'month') return d.toLocaleDateString([], { month: 'short' });
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  };
  const tipFor = (b) => {
    const prefix = unit === 'week' ? 'Week of ' : '';
    const replies = `${b.replies.toLocaleString()} ${b.replies === 1 ? 'reply' : 'replies'}`;
    return `${prefix}${labelFor(b.label)} — ${b.sent.toLocaleString()} accepted, ${replies}`;
  };

  // Keep axis labels from colliding: roughly one per 46px
  const labelStep = Math.max(1, Math.ceil(buckets.length / Math.floor(plotWidth / 46)));

  let bars = '';
  let labels = '';
  buckets.forEach((b, i) => {
    const centre = padLeft + slot * i + slot / 2;
    const sentH = (b.sent / max) * plotHeight;
    const replyH = (b.replies / max) * plotHeight;
    const tip = tipFor(b);

    bars += `<rect class="bar-sent" x="${(centre - barWidth - 1).toFixed(1)}" y="${(baseline - sentH).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(sentH, b.sent ? 1.5 : 0).toFixed(1)}" rx="1.5"><title>${tip}</title></rect>`;
    bars += `<rect class="bar-replies" x="${(centre + 1).toFixed(1)}" y="${(baseline - replyH).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(replyH, b.replies ? 1.5 : 0).toFixed(1)}" rx="1.5"><title>${tip}</title></rect>`;

    if (i % labelStep === 0) {
      labels += `<text class="axis-label" x="${centre.toFixed(1)}" y="${(height - 6).toFixed(1)}" text-anchor="middle">${labelFor(b.label)}</text>`;
    }
  });

  // Horizontal gridlines with value labels
  let grid = '';
  [0, 0.5, 1].forEach(fraction => {
    const y = baseline - fraction * plotHeight;
    grid += `<line class="grid-line" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${(width - padRight).toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
    grid += `<text class="axis-label" x="${padLeft - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${Math.round(max * fraction).toLocaleString()}</text>`;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="stats-chart-svg" role="img" aria-label="Messages accepted by the carrier and replies received over time">
      ${grid}${bars}${labels}
    </svg>`;
}

// The chart is sized in pixels, so it has to be redrawn when the window changes
window.addEventListener('resize', () => {
  const overlay = document.getElementById('stats-overlay');
  if (lastChartData && overlay && overlay.classList.contains('open')) {
    renderStatsChart(lastChartData.daily, lastChartData.from, lastChartData.to);
  }
});

function renderFunnel(stats) {
  const container = document.getElementById('stats-funnel');
  if (!container) return;

  const steps = [
    { label: 'Carrier accepted', value: stats.sent.carrier_accepted, cls: 'step-delivered' },
    { label: 'Contacts reached', value: stats.sent.contacts_accepted, cls: 'step-contacts' },
    { label: 'Replied', value: stats.responses.unique_responders, cls: 'step-replied' },
    { label: 'Positive', value: stats.responses.positive_contacts, cls: 'step-positive' },
    { label: 'Appointments', value: stats.dispositions.appointment, cls: 'step-appointment' },
    { label: 'Customers', value: stats.dispositions.customer, cls: 'step-customer' }
  ];

  const top = Math.max(1, steps[0].value);

  container.innerHTML = steps.map((step, i) => {
    const value = step.value || 0;
    const width = Math.max(2, (value / top) * 100);
    const previous = i === 0 ? null : (steps[i - 1].value || 0);
    const conversion = previous > 0 ? `${Math.round((value / previous) * 1000) / 10}%` : (i === 0 ? '' : '\u2014');
    return `
      <div class="funnel-step">
        <div class="funnel-step-head">
          <span class="funnel-label">${escapeHTML(step.label)}</span>
          <span class="funnel-value">${value.toLocaleString()}${conversion ? `<span class="funnel-conv">${conversion}</span>` : ''}</span>
        </div>
        <div class="funnel-track"><div class="funnel-fill ${step.cls}" style="width: ${width}%"></div></div>
      </div>`;
  }).join('');
}

function renderDispositionBreakdown(dispositions) {
  const container = document.getElementById('stats-dispositions');
  if (!container) return;

  const order = [
    ['appointment', 'Appointments', 'dispo-appointment'],
    ['follow_up', 'Follow-Ups', 'dispo-follow_up'],
    ['customer', 'Customers', 'dispo-customer'],
    ['no', 'No', 'dispo-no'],
    ['unqualified', 'Unqualified', 'dispo-unqualified']
  ];

  const total = order.reduce((sum, [key]) => sum + (dispositions[key] || 0), 0);

  container.innerHTML = order.map(([key, label, cls]) => {
    const value = dispositions[key] || 0;
    const share = total > 0 ? Math.round((value / total) * 100) : 0;
    return `
      <div class="disposition-stat ${cls}">
        <div class="disposition-stat-value">${value.toLocaleString()}</div>
        <div class="disposition-stat-label">${label}</div>
        <div class="disposition-stat-bar"><span style="width: ${share}%"></span></div>
      </div>`;
  }).join('');
}

function renderStats(stats) {
  const num = n => (n || 0).toLocaleString();
  const set = (id, value, title) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
    if (title) el.title = title;
  };

  const defs = stats.rate_definitions || {};

  set('stats-range-label', formatRangeLabel(stats.from, stats.to));

  // Attempted: every outbound row created in the window.
  set('kpi-sent', num(stats.sent.attempted));
  set('kpi-sent-sub',
      `${num(stats.sent.carrier_accepted)} accepted by carrier \u00b7 ${num(stats.sent.failed)} failed`,
      'Outbound messages created in this period, whatever their outcome');

  // Carrier acceptance is NOT delivery. Both are shown, labelled honestly.
  // The carrier on this route does not return delivery receipts, so handset
  // delivery is unknowable. A separate "Delivered" figure would sit at ~0
  // forever and read as catastrophic failure, so confirmed deliveries are
  // mentioned only when receipts genuinely arrive.
  set('kpi-accepted', num(stats.sent.carrier_accepted));
  set('kpi-accepted-sub',
      stats.sent.delivered > 0
        ? `${stats.sent.acceptance_rate}% accepted \u00b7 ${num(stats.sent.delivered)} delivery-confirmed`
        : `${stats.sent.acceptance_rate}% accepted by the carrier`,
      defs.acceptance_rate);

  set('kpi-responses', num(stats.responses.total_messages));
  set('kpi-responses-sub',
      `${num(stats.responses.unique_responders)} unique contacts \u00b7 ${stats.responses.response_rate}% reply rate`,
      defs.response_rate);

  // Contact-level, so one chatty lead cannot inflate the figure.
  set('kpi-positive', num(stats.responses.positive_contacts));
  set('kpi-positive-rate', `${stats.responses.positive_rate_of_responders}%`, defs.positive_rate_of_responders);
  set('kpi-positive-sub',
      `${stats.responses.positive_rate_of_responders}% of responders \u00b7 ${stats.responses.positive_rate_of_contacted}% of contacts reached \u00b7 ${num(stats.responses.positive_messages)} messages`,
      defs.positive_rate_of_contacted);

  set('kpi-negative', num(stats.responses.negative_contacts));
  set('kpi-negative-rate', `${stats.responses.negative_rate_of_responders}%`, defs.negative_rate_of_responders);
  set('kpi-negative-sub',
      `${num(stats.responses.opt_out_contacts)} opted out \u00b7 ${num(stats.responses.wrong_number_contacts)} wrong number`,
      'Not interested, counted per contact. Legal opt-outs are counted separately.');

  // Secondary metrics
  set('ms-contacts', num(stats.sent.contacts_reached));
  set('ms-new-leads', num(stats.new_leads));
  set('ms-failed', num(stats.sent.failed));
  set('ms-inflight', num(stats.sent.queued));
  set('ms-optouts', num(stats.suppression.opt_outs_recorded),
      'Contacts permanently suppressed during this period');
  set('ms-reply-time', formatDuration(stats.avg_reply_minutes));
  set('ms-peak-hour', formatHour(stats.peak_reply_hour));

  renderStatsChart(stats.daily, stats.from, stats.to);
  renderFunnel(stats);
  renderDispositionBreakdown(stats.dispositions);
}

async function loadStats() {
  const from = document.getElementById('stats-from').value;
  const to = document.getElementById('stats-to').value;
  const loading = document.getElementById('stats-loading');
  const content = document.getElementById('stats-content');

  if (!from || !to) return;
  if (from > to) {
    loading.textContent = 'The "From" date must not be after the "To" date.';
    loading.style.display = 'block';
    content.style.display = 'none';
    return;
  }

  loading.textContent = 'Loading performance data…';
  loading.style.display = 'block';

  // Send the exact UTC instants that bound the user's LOCAL day range.
  // Without this a message sent at 8pm Eastern lands on the next UTC day and
  // disappears from "Today".
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const startLocal = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
  const endLocal = new Date(ty, tm - 1, td + 1, 0, 0, 0, 0); // exclusive
  const tzOffset = -new Date().getTimezoneOffset(); // minutes to add to UTC

  const query = `from=${from}&to=${to}` +
    `&start=${encodeURIComponent(startLocal.toISOString())}` +
    `&end=${encodeURIComponent(endLocal.toISOString())}` +
    `&tz_offset=${tzOffset}`;

  try {
    const res = await fetch(`/api/stats?${query}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to load stats');
    }
    const stats = await res.json();
    renderStats(stats);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    console.error('Stats error:', err);
    loading.textContent = 'Could not load performance data.';
    content.style.display = 'none';
  }
}

function applyStatsPreset(preset) {
  const [from, to] = resolveDatePreset(preset);
  document.getElementById('stats-from').value = from;
  document.getElementById('stats-to').value = to;
  document.querySelectorAll('.stats-preset').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
  loadStats();
}

function setupStatsPanel() {
  const overlay = document.getElementById('stats-overlay');
  const btnOpen = document.getElementById('btn-open-stats');
  const btnClose = document.getElementById('stats-close');
  const btnApply = document.getElementById('btn-apply-stats');
  const fromInput = document.getElementById('stats-from');
  const toInput = document.getElementById('stats-to');
  if (!overlay || !btnOpen) return;

  btnOpen.addEventListener('click', () => {
    overlay.classList.add('open');
    // Default to this month on first open, then keep whatever the user picked
    if (!fromInput.value || !toInput.value) {
      applyStatsPreset('last-30');
    } else {
      loadStats();
    }
  });

  const close = () => overlay.classList.remove('open');
  btnClose.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  document.querySelectorAll('.stats-preset').forEach(btn => {
    btn.addEventListener('click', () => applyStatsPreset(btn.dataset.preset));
  });

  // Hand-picking dates clears the preset selection
  [fromInput, toInput].forEach(input => {
    input.addEventListener('change', () => {
      document.querySelectorAll('.stats-preset').forEach(b => b.classList.remove('active'));
      loadStats();
    });
  });

  btnApply.addEventListener('click', loadStats);
}

// Bulk sends skip opted-out and closed contacts; say so rather than silently dropping them.
function skippedNote(count) {
  if (!count) return '';
  return `

${count} contact${count === 1 ? ' was' : 's were'} skipped: opted out, or marked No / Unqualified / Customer. Open a conversation to message them individually.`;
}

// Escaping HTML utility
function escapeHTML(str) {
  return String(str == null ? '' : str)
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
    let cityIdx = headers.findIndex(h => /city/i.test(h));
    let zipIdx = headers.findIndex(h => /zip|postal/i.test(h));

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
      const city = cityIdx !== -1 && cityIdx < columns.length ? columns[cityIdx] : '';
      const zip = zipIdx !== -1 && zipIdx < columns.length ? columns[zipIdx] : '';

      if (phone && phone.length >= 7) {
        tempLeads.push({
          phone_number: phone,
          name: name || null,
          city: city || null,
          zip: zip || null
        });
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
      alert(`Success! Imported ${data.imported_count} leads and queued ${data.queued_count} messages.` + skippedNote(data.skipped_count));
      
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

// Helper to convert ISO/SQLite datetime string to EST YYYY-MM-DD string
function getLocalDateString(dateStr) {
  if (!dateStr) return null;
  const date = parseUtc(dateStr) || new Date(dateStr.includes('T') || dateStr.includes(' ') ? dateStr.replace(' ', 'T') : dateStr);
  if (!date || isNaN(date.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    return formatter.format(date);
  } catch (e) {
    return null;
  }
}

// Helper to format message timestamp to date and time in EST (e.g. Jun 8, 12:45 PM)
function formatMessageTimestamp(dateInput) {
  if (!dateInput) return '';
  const date = dateInput instanceof Date ? dateInput : parseUtc(dateInput) || new Date(dateInput);
  if (!date || isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { 
    timeZone: 'America/New_York',
    month: 'short', 
    day: 'numeric', 
    hour: 'numeric', 
    minute: '2-digit' 
  });
}

// Helper to format note timestamp in EST (e.g. Aug 3, 2026, 10:03 PM EST)
function formatNoteTimestamp(dateInput) {
  if (!dateInput) return '';
  const date = dateInput instanceof Date ? dateInput : parseUtc(dateInput) || new Date(dateInput);
  if (!date || isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }) + ' EST';
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

  // Every interpolated value here is attacker-controlled: bodyText and
  // nameOrPhone come straight from an inbound SMS. Escape all of them.
  return `
    <div class="timeline-item ${escapeHTML(statusClass)}" data-activity-id="${escapeHTML(msg.id)}">
      <div class="timeline-badge"></div>
      <div class="timeline-header">
        <span class="timeline-title">${escapeHTML(title)}</span>
        <span class="timeline-time">${escapeHTML(timeAgoStr)}</span>
      </div>
      <div class="timeline-body" title="${escapeHTML(`${bodyText} (${statusLabel})`)}">${escapeHTML(bodyText)}</div>
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
  
  if (currentView === 'storm-demo') {
    chatHeader.style.display = 'none';
    messagesFeed.style.display = 'none';
    chatComposerContainer.style.display = 'none';
    updateDispositionBar(null);

    if (stormLeadsView) {
      stormLeadsView.style.display = 'flex';
      renderStormLeadsTable();
    }
  } else {
    if (activeConversation && !activeConversation.isLead) {
      chatHeader.style.display = 'flex';
      messagesFeed.style.display = 'flex';
      chatComposerContainer.style.display = 'block';
    } else {
      chatHeader.style.display = 'flex';
      messagesFeed.style.display = 'flex';
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
  updateTabCounts();
}

/* ------------------------------------------------------------------
 * Prospect Notes Helper Functions
 * ------------------------------------------------------------------ */
let activeNotes = [];

async function loadNotesForActiveConversation() {
  const btnToggleNotes = document.getElementById('btn-toggle-notes');
  if (!btnToggleNotes) return;

  if (!activeConversation) {
    btnToggleNotes.style.display = 'none';
    closeNotesDrawer();
    return;
  }

  btnToggleNotes.style.display = 'inline-flex';

  try {
    const targetId = activeConversation.id;
    const phone = activeConversation.phone_number || '';
    const url = `/api/conversations/${targetId}/notes?phone_number=${encodeURIComponent(phone)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load notes");
    activeNotes = await res.json();
    renderNotesFeed();
  } catch (err) {
    console.error("Error loading notes:", err);
  }
}

function renderNotesFeed() {
  ['notes-badge-count', 'notes-badge-count-header', 'notes-badge-count-floating'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = activeNotes.length;
      el.style.display = activeNotes.length > 0 ? 'inline-block' : 'none';
    }
  });
  const metaEl = document.getElementById('notes-prospect-meta');
  const feedEl = document.getElementById('notes-feed');

  if (metaEl && activeConversation) {
    const nameStr = activeConversation.name || 'Unnamed Prospect';
    const phoneStr = activeConversation.phone_number || '';
    const state = window.AreaCodes ? window.AreaCodes.getStateFromPhone(phoneStr) : null;
    metaEl.innerHTML = `<strong>${escapeHTML(nameStr)}</strong> (${escapeHTML(phoneStr)}${state ? ` · ${state}` : ''})`;
  }

  if (!feedEl) return;

  if (activeNotes.length === 0) {
    feedEl.innerHTML = '<div class="notes-empty">No notes recorded for this prospect yet.</div>';
    return;
  }

  feedEl.innerHTML = activeNotes.map(n => {
    const formattedTime = formatNoteTimestamp(n.created_at);
    return `
      <div class="note-item" data-note-id="${n.id}">
        <div class="note-item-header">
          <span class="note-item-timestamp">${escapeHTML(formattedTime)}</span>
          <button type="button" class="note-delete-btn" onclick="deleteNoteItem(${n.id})" title="Delete note">&times;</button>
        </div>
        <div class="note-item-text">${escapeHTML(n.note_text)}</div>
      </div>
    `;
  }).join('');
}

async function addNoteForActiveConversation(noteText) {
  if (!activeConversation || !noteText.trim()) return;
  try {
    const res = await fetch(`/api/conversations/${activeConversation.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note_text: noteText.trim(),
        phone_number: activeConversation.phone_number
      })
    });
    if (!res.ok) throw new Error("Failed to add note");
    const newNote = await res.json();
    activeNotes.unshift(newNote);
    renderNotesFeed();
  } catch (err) {
    console.error("Error saving note:", err);
    alert("Failed to save note: " + err.message);
  }
}

async function deleteNoteItem(noteId) {
  if (!confirm("Are you sure you want to delete this note?")) return;
  try {
    const res = await fetch(`/api/notes/${noteId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error("Failed to delete note");
    activeNotes = activeNotes.filter(n => n.id !== noteId);
    renderNotesFeed();
  } catch (err) {
    console.error("Error deleting note:", err);
  }
}

function toggleNotesDrawer() {
  const drawer = document.getElementById('notes-drawer');
  const banner = document.getElementById('reminder-banner');
  if (!drawer) return;
  if (drawer.style.display === 'none' || !drawer.style.display) {
    drawer.style.display = 'flex';
    document.body.classList.add('notes-open');
    if (banner) banner.style.display = 'none';
    renderNotesFeed();
  } else {
    drawer.style.display = 'none';
    document.body.classList.remove('notes-open');
    if (typeof checkReminders === 'function') checkReminders();
  }
}

function closeNotesDrawer() {
  const drawer = document.getElementById('notes-drawer');
  if (drawer) drawer.style.display = 'none';
  document.body.classList.remove('notes-open');
  if (typeof checkReminders === 'function') checkReminders();
}

document.addEventListener('DOMContentLoaded', () => {
  const btnSidebarNotes = document.getElementById('btn-sidebar-notes');
  if (btnSidebarNotes) {
    btnSidebarNotes.addEventListener('click', toggleNotesDrawer);
  }
  const btnHeaderNotes = document.getElementById('btn-toggle-notes-header');
  if (btnHeaderNotes) {
    btnHeaderNotes.addEventListener('click', toggleNotesDrawer);
  }
  const btnChatNotes = document.getElementById('btn-toggle-notes');
  if (btnChatNotes) {
    btnChatNotes.addEventListener('click', toggleNotesDrawer);
  }
});

