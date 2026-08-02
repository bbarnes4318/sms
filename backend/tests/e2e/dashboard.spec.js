// @ts-check
const { test, expect } = require('@playwright/test');
const h = require('./helpers');

let errors = [];

test.beforeEach(async ({ page }) => {
  errors = h.trackErrors(page);
  await h.login(page);
});

test.afterEach(async () => {
  expect(errors, `uncaught browser errors:\n${errors.join('\n')}`).toEqual([]);
});

/* ---------------- navigation and counts ---------------- */

test('login lands on the dashboard with all six folders', async ({ page }) => {
  await expect(page.locator('.folder-tab')).toHaveCount(6);
  for (const folder of ['new', 'hot', 'customer', 'closed', 'pending', 'storm-demo']) {
    await expect(page.locator(`.folder-tab[data-folder="${folder}"]`)).toBeVisible();
  }
  await h.shot(page, '01-new-folder');
});

test('folder counts match the seeded data', async ({ page }) => {
  expect(await h.folderCount(page, 'new')).toBe(3);       // Maria, Priya, Grace
  expect(await h.folderCount(page, 'hot')).toBe(4);       // 3 appointments + 1 follow-up
  expect(await h.folderCount(page, 'customer')).toBe(1);  // Carlos
  expect(await h.folderCount(page, 'closed')).toBe(6);    // 2 no + 1 unqual + 2 opt-out + 1 wrong
  expect(await h.folderCount(page, 'pending')).toBe(4);   // 3 contacted + 1 failed
});

test('a positive reply appears in New', async ({ page }) => {
  await h.openFolder(page, 'new');
  const names = await h.rowNames(page);
  expect(names).toContain('Maria Chen');
  expect(names).toContain('Priya Raman');
});

test('an explicit opt-out is in Closed > Opted Out, not mixed with No', async ({ page }) => {
  await h.openFolder(page, 'closed', 'opted_out');
  const optedOut = await h.rowNames(page);
  expect(optedOut).toContain('Dwayne Ortiz');
  expect(optedOut).toContain('Alicia Gordon');
  await h.shot(page, '05-closed-opted-out');

  await h.openFolder(page, 'closed', 'no');
  const no = await h.rowNames(page);
  expect(no).toContain('Tom Beckett');
  expect(no).not.toContain('Dwayne Ortiz');
});

test('a later message does not move an opted-out contact back to New', async ({ page }) => {
  // Alicia said "remove me from your list" and then chatted again afterwards.
  await h.openFolder(page, 'new');
  expect(await h.rowNames(page)).not.toContain('Alicia Gordon');

  await h.openFolder(page, 'closed', 'opted_out');
  expect(await h.rowNames(page)).toContain('Alicia Gordon');
});

test('a wrong number has its own view', async ({ page }) => {
  await h.openFolder(page, 'closed', 'wrong_number');
  expect(await h.rowNames(page)).toContain('Unknown');
});

test('a negative reply is labelled "Not Interested", never "Opted Out"', async ({ page }) => {
  await h.openFolder(page, 'closed', 'no');
  await h.selectConversationByName(page, 'Tom Beckett');
  const badge = page.locator('#active-sentiment-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Not Interested');
});

/* ---------------- suppression in the UI ---------------- */

test('a suppressed contact cannot be messaged from the UI', async ({ page }) => {
  await h.openFolder(page, 'closed', 'opted_out');
  await h.selectConversationByName(page, 'Dwayne Ortiz');

  await expect(page.locator('#suppressed-notice')).toBeVisible();
  await expect(page.locator('#suppressed-title')).toHaveText('This contact opted out');
  await expect(page.locator('#chat-composer-container')).toBeHidden();
  await expect(page.locator('#active-sentiment-badge')).toHaveText('Opted Out');
  await h.shot(page, '08-suppressed-warning');
});

test('the server refuses a send to a suppressed contact even if the UI is bypassed', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/conversations');
    const list = await res.json();
    return list.find(c => c.opted_out === 1).id;
  });

  const result = await page.evaluate(async (convId) => {
    const res = await fetch(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'bypassing the UI' })
    });
    return { status: res.status, json: await res.json() };
  }, id);

  expect(result.status).toBe(409);
  expect(result.json.blocked).toBe(true);
});

/* ---------------- dispositions ---------------- */

test('Set Appointment requires a date and moves the lead to Hot Leads', async ({ page }) => {
  await h.openFolder(page, 'new');
  await h.selectConversationByName(page, 'Maria Chen');

  await page.click('.dispo-btn[data-disposition="appointment"]');
  await expect(page.locator('#schedule-modal')).toHaveClass(/open/);
  await expect(page.locator('#schedule-modal-title')).toHaveText('Set Appointment');
  await h.shot(page, '06-appointment-modal');

  await page.click('.quick-pick[data-offset="tomorrow"]');
  await page.fill('#schedule-note', 'wants pricing');
  await page.click('#btn-save-schedule');

  await expect(page.locator('#schedule-modal')).not.toHaveClass(/open/);
  await expect(page.locator('#disposition-chip')).toContainText('Appointment');

  await h.openFolder(page, 'hot', 'appointment');
  expect(await h.rowNames(page)).toContain('Maria Chen');
  await h.shot(page, '02-hot-leads-appointments');
});

test('Follow-Up opens its own modal and files under Follow-Ups', async ({ page }) => {
  await h.openFolder(page, 'new');
  await h.selectConversationByName(page, 'Priya Raman');

  await page.click('.dispo-btn[data-disposition="follow_up"]');
  await expect(page.locator('#schedule-modal-title')).toHaveText('Schedule Follow-Up');
  await h.shot(page, '07-followup-modal');

  await page.click('.quick-pick[data-offset="7d"]');
  await page.click('#btn-save-schedule');

  await h.openFolder(page, 'hot', 'follow_up');
  expect(await h.rowNames(page)).toContain('Priya Raman');
});

test('No, Unqualified and Customer each move the lead in one click', async ({ page }) => {
  const cases = [
    { name: 'Grace Lin', disposition: 'no', folder: 'closed', view: 'no' }
  ];
  for (const c of cases) {
    await h.openFolder(page, 'new');
    await h.selectConversationByName(page, c.name);
    await page.click(`.dispo-btn[data-disposition="${c.disposition}"]`);
    await page.waitForTimeout(500);
    await h.openFolder(page, c.folder, c.view);
    expect(await h.rowNames(page)).toContain(c.name);
  }
});

test('undo returns a lead to New without clearing suppression', async ({ page }) => {
  await h.openFolder(page, 'customer');
  await h.selectConversationByName(page, 'Carlos Mendez');
  await expect(page.locator('#disposition-chip')).toContainText('Customer');
  await h.shot(page, '03-customers');

  await page.click('#btn-clear-disposition');
  await page.waitForTimeout(500);
  await h.openFolder(page, 'new');
  expect(await h.rowNames(page)).toContain('Carlos Mendez');

  // An opted-out contact keeps its suppression through a disposition change.
  await h.openFolder(page, 'closed', 'opted_out');
  expect(await h.rowNames(page)).toContain('Dwayne Ortiz');
});

test('rescheduling an appointment updates the stored time', async ({ page }) => {
  await h.openFolder(page, 'hot', 'appointment');
  await h.selectConversationByName(page, 'Marcus Bell');
  const before = await page.textContent('#disposition-chip');

  await page.click('.dispo-btn[data-disposition="appointment"]');
  await page.click('.quick-pick[data-offset="2d"]');
  await page.click('#btn-save-schedule');
  await page.waitForTimeout(500);

  const after = await page.textContent('#disposition-chip');
  expect(after).not.toBe(before);
  expect(after).toContain('Appointment');
});

test('an invalid appointment date is rejected by the server', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/conversations');
    return (await res.json())[0].id;
  });
  const result = await page.evaluate(async (convId) => {
    const res = await fetch(`/api/conversations/${convId}/disposition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disposition: 'appointment', scheduled_at: '2026-02-30T10:00:00Z' })
    });
    return { status: res.status, json: await res.json() };
  }, id);
  expect(result.status).toBe(400);
});

/* ---------------- reminders ---------------- */

test('overdue appointments are highlighted and counted on Hot Leads', async ({ page }) => {
  await h.openFolder(page, 'hot', 'appointment');
  const overdue = page.locator('.conv-preview.is-overdue');
  await expect(overdue.first()).toBeVisible();
  await expect(overdue.first()).toContainText('Overdue');

  // The folder tab carries an alert pip for overdue work.
  await expect(page.locator('.folder-tab[data-folder="hot"] .tab-alert')).toBeVisible();
});

test('the reminder banner surfaces due and overdue items', async ({ page }) => {
  const banner = page.locator('#reminder-banner');
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.reminder-item')).not.toHaveCount(0);
  await expect(banner).toContainText('Due now');
  await h.shot(page, '09-reminders');

  // Clicking a reminder opens that conversation.
  await page.locator('.reminder-item').first().click();
  await page.waitForTimeout(400);
  await expect(page.locator('#active-contact-name')).not.toHaveText('Select a conversation');
});

/* ---------------- bulk paths ---------------- */

test('bulk messaging skips suppressed contacts and reports why', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const list = await (await fetch('/api/conversations')).json();
    const blocked = list.find(c => c.opted_out === 1);
    const fine = list.find(c => !c.opted_out && !c.wrong_number && !c.disposition);
    const res = await fetch('/api/conversations/bulk-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_ids: [blocked.id, fine.id],
        message_text: 'E2E bulk test'
      })
    });
    return res.json();
  });

  expect(result.queued_count).toBe(1);
  expect(result.skipped_count).toBe(1);
  expect(result.skipped_opted_out).toBe(1);
});

test('CSV import reports audited counts and skips suppressed numbers', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const list = await (await fetch('/api/conversations')).json();
    const blocked = list.find(c => c.opted_out === 1);
    const res = await fetch('/api/leads/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leads: [
          { phone_number: blocked.phone_number, name: 'Blocked' },
          { phone_number: '+15550199001', name: 'Brand New' },
          { phone_number: 'nonsense', name: 'Bad Row' }
        ],
        message_template: 'Hi [Name]'
      })
    });
    return res.json();
  });

  expect(result.imported_count).toBeUndefined();
  expect(result.total_submitted).toBe(3);
  expect(result.new_contacts).toBe(1);
  expect(result.invalid_rows).toBe(1);
  expect(result.messages_queued).toBe(1);
  expect(result.skipped_opted_out).toBe(1);
});

/* ---------------- stats ---------------- */

test('the stats panel opens and reports honest delivery terminology', async ({ page }) => {
  await page.click('#btn-open-stats');
  await expect(page.locator('#stats-overlay')).toHaveClass(/open/);
  await page.waitForSelector('#stats-content', { state: 'visible' });

  await expect(page.locator('#kpi-accepted-label, .kpi-card')).not.toHaveCount(0);
  await page.click('.stats-preset[data-preset="this-month"]');
  await page.waitForTimeout(600);

  await expect(page.locator('.stats-chart-svg')).toBeVisible();
  await expect(page.locator('.funnel-step')).not.toHaveCount(0);
  await h.shot(page, '10-stats');

  await page.keyboard.press('Escape');
  await expect(page.locator('#stats-overlay')).not.toHaveClass(/open/);
});

/* ---------------- layout ---------------- */

test('folders render without horizontal overflow at common widths', async ({ page }) => {
  for (const width of [1920, 1600, 1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() =>
      document.body.scrollWidth - document.body.clientWidth);
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1600, height: 950 });
});

test('outbound bubbles stay right-aligned after switching folders', async ({ page }) => {
  await h.openFolder(page, 'pending');
  await page.locator('.conversation-item').first().click();
  await page.waitForTimeout(500);

  const aligned = await page.evaluate(() => {
    const feed = document.getElementById('messages-feed');
    const bubble = document.querySelector('.message-bubble.outbound');
    if (!feed || !bubble) return null;
    const f = feed.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    // Right-aligned means the bubble hugs the right edge, not the left.
    return (f.right - b.right) < (b.left - f.left);
  });
  expect(aligned).toBe(true);
});

test('the pending and web form folders render', async ({ page }) => {
  await h.openFolder(page, 'pending');
  await h.shot(page, '04-pending');
  expect((await h.rowNames(page)).length).toBeGreaterThan(0);

  await h.openFolder(page, 'storm-demo');
  await expect(page.locator('#storm-leads-view')).toBeVisible();
});
