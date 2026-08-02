'use strict';

const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots');

const ADMIN = { username: 'e2e-admin', password: 'e2e-password-123' };

/** Create the admin on first use, then sign in. */
async function login(page) {
  await page.goto('/login');

  // The login page shows a signup form when no admin exists yet.
  const signupVisible = await page.locator('#signup-form, [data-mode="signup"]').count();
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/auth/status');
    return res.json();
  });

  if (!status.has_admin) {
    await page.evaluate(async (creds) => {
      await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds)
      });
    }, ADMIN);
  } else {
    await page.evaluate(async (creds) => {
      await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds)
      });
    }, ADMIN);
  }

  await page.goto('/');
  await page.waitForSelector('.folder-tab', { state: 'visible' });
  // Conversations arrive asynchronously; wait for the first render to settle.
  await page.waitForFunction(() => {
    const el = document.getElementById('count-folder-pending');
    return el && Number(el.textContent) >= 0 && document.querySelectorAll('.folder-tab').length === 6;
  });
  return signupVisible;
}

/** Collect uncaught page errors and console errors for later assertion. */
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // WebSocket churn, favicon 404s and deliberately provoked 4xx responses
    // are environmental or intentional, not application defects.
    if (/WebSocket|favicon|net::ERR_/i.test(text)) return;
    if (/Failed to load resource/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

async function openFolder(page, folder, view) {
  await page.click(`.folder-tab[data-folder="${folder}"]`);
  if (view) {
    await page.click(`.subtab[data-view="${view}"]`);
  }
  await page.waitForTimeout(250);
}

async function folderCount(page, folder) {
  const text = await page.textContent(`#count-folder-${folder}`);
  return Number(text);
}

async function viewCount(page, view) {
  const text = await page.textContent(`#count-${view}`);
  return Number(text);
}

async function rowNames(page) {
  return page.$$eval('.conversation-item .conv-name',
    els => els.map(e => e.textContent.trim()));
}

async function selectConversationByName(page, name) {
  await page.click(`.conversation-item:has(.conv-name:text-is("${name}"))`);
  await page.waitForTimeout(400);
}

async function shot(page, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

module.exports = {
  ADMIN, SCREENSHOT_DIR,
  login, trackErrors, openFolder, folderCount, viewCount,
  rowNames, selectConversationByName, shot
};
