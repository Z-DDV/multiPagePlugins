// content/mail-163.js — Content script for 163 Mail (steps 4, 7)
// Injected on: mail.163.com
//
// DOM structure:
// Mail item: div[sign="letter"] with aria-label="你的 ChatGPT 代码为 479637 发件人 ： OpenAI ..."
// Sender: .nui-user (e.g., "OpenAI")
// Subject: span.da0 (e.g., "你的 ChatGPT 代码为 479637")
// Right-click menu: .nui-menu → .nui-menu-item with text "删除邮件"

const MAIL163_PREFIX = '[MultiPage:mail-163]';
const isTopFrame = window === window.top;
const MAIL163_INBOX_HASH = 'module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D';
const MAIL163_INBOX_LABEL = '\u6536\u4ef6\u7bb1';
const MAIL163_REFRESH_LABEL = '\u5237\u65b0';
const MAIL163_RECEIVE_LABEL = '\u6536\u4fe1';

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// Only operate in the top frame
if (!isTopFrame) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
} else {

// Track codes we've already seen — persisted in chrome.storage.session to survive script re-injection
let seenCodes = new Set();

async function loadSeenCodes() {
  try {
    const data = await chrome.storage.session.get('seenCodes');
    if (data.seenCodes && Array.isArray(data.seenCodes)) {
      seenCodes = new Set(data.seenCodes);
      console.log(MAIL163_PREFIX, `Loaded ${seenCodes.size} previously seen codes`);
    }
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Session storage unavailable, using in-memory seen codes:', err?.message || err);
  }
}

// Load previously seen codes on startup
loadSeenCodes();

async function persistSeenCodes() {
  try {
    await chrome.storage.session.set({ seenCodes: [...seenCodes] });
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Could not persist seen codes, continuing in-memory only:', err?.message || err);
  }
}

// ============================================================
// Message Handler (top frame only)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      if (!message.payload?.suppressStepError) {
        reportError(message.step, err.message);
      }
      sendResponse({ error: err.message });
    });
    return true;
  }
});

// ============================================================
// Find mail items
// ============================================================

function parseEmailDate(item) {
  const aria = item.getAttribute('aria-label') || '';
  const m = aria.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})[日]?\s*(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  const d = aria.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
  if (d) return new Date(+d[1], d[2] - 1, +d[3]).getTime();
  return 0;
}

function findMailItems() {
  return document.querySelectorAll('div[sign="letter"]');
}

function getMailItemKey(item) {
  if (!item) return '';

  const id = String(item.getAttribute('id') || '').trim();
  if (id) return `id:${id}`;

  const sender = normalizeMail163Text(item.querySelector('.nui-user')?.textContent || '');
  const subject = normalizeMail163Text(item.querySelector('span.da0')?.textContent || '');
  const aria = normalizeMail163Text(item.getAttribute('aria-label') || '');

  if (aria) return `aria:${aria}`;
  if (sender || subject) return `text:${sender}|${subject}`;
  return '';
}

function getCurrentMailKeys() {
  const keys = new Set();
  findMailItems().forEach(item => {
    const key = getMailItemKey(item);
    if (key) keys.add(key);
  });
  return keys;
}

function normalizeMail163Text(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function isInboxModuleActive() {
  return location.hash.includes('mbox.ListModule');
}

function findInboxLink() {
  const direct = document.querySelector(`[title="${MAIL163_INBOX_LABEL}"], [title*="${MAIL163_INBOX_LABEL}"]`);
  if (direct) return direct;

  const candidates = document.querySelectorAll('.nui-tree-item-text, .nui-tree-item, a, span, div[role="treeitem"]');
  for (const candidate of candidates) {
    const label = normalizeMail163Text(`${candidate.textContent || ''} ${candidate.getAttribute?.('title') || ''}`);
    if (label.includes(MAIL163_INBOX_LABEL)) {
      return candidate;
    }
  }
  return null;
}

async function waitForInboxLink(timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();
    const inboxLink = findInboxLink();
    if (inboxLink) return inboxLink;
    await sleep(200);
  }
  return null;
}

async function ensureInboxView(step) {
  if (!isInboxModuleActive()) {
    log(`Step ${step}: Current page is not inbox, switching 163 module to inbox...`);
    location.hash = MAIL163_INBOX_HASH;
    await sleep(1500);
  }

  const inboxLink = await waitForInboxLink().catch(() => null);
  if (!inboxLink) {
    log(`Step ${step}: Inbox link not found after switching module`, 'warn');
    return;
  }

  simulateClick(inboxLink);
  log(`Step ${step}: Clicked inbox`);
  await sleep(1000);
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const {
    disableFallback = false,
    excludeCodes = [],
    senderFilters,
    subjectFilters,
    maxAttempts,
    intervalMs,
    filterAfterTimestamp = 0,
    fallbackAfterAttempts,
  } = payload;
  const excludedCodeSet = new Set(
    (excludeCodes || []).map((item) => String(item || '').trim()).filter(Boolean)
  );

  log(`Step ${step}: Starting email poll on 163 Mail (max ${maxAttempts} attempts)`);

  await ensureInboxView(step);

  // Wait for mail list container to appear (page loaded check, inbox can be empty)
  log(`Step ${step}: Waiting for mail list...`);
  try {
    await waitForElement('.mail-list, div[sign="letter"], .nui-tree, .nui-main', 12000);
    log(`Step ${step}: Mail page loaded`);
  } catch {
    log(`Step ${step}: Mail page may not be fully loaded, proceeding to poll anyway...`, 'warn');
  }

  // Snapshot existing mail IDs (may be empty if inbox is empty)
  const existingMailKeys = getCurrentMailKeys();
  log(`Step ${step}: Snapshotted ${existingMailKeys.size} existing emails`);

  const fallbackEnabled = !disableFallback && maxAttempts > 1;
  const fallbackAfter = fallbackEnabled
    ? Math.min(
      maxAttempts - 1,
      Math.max(1, Number.isFinite(fallbackAfterAttempts) ? fallbackAfterAttempts : Math.ceil(maxAttempts * 0.8))
    )
    : Number.POSITIVE_INFINITY;
  const allowExistingMailFallback = fallbackEnabled && !filterAfterTimestamp;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling 163 Mail... attempt ${attempt}/${maxAttempts}`);

    await refreshInbox();
    await sleep(1000);

    const allItems = findMailItems();
    const useFallback = allowExistingMailFallback && attempt > fallbackAfter;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';
      const itemKey = getMailItemKey(item);

      if (!useFallback && itemKey && existingMailKeys.has(itemKey)) continue;

      const senderEl = item.querySelector('.nui-user');
      const sender = senderEl ? senderEl.textContent.toLowerCase() : '';

      const subjectEl = item.querySelector('span.da0');
      const subject = subjectEl ? subjectEl.textContent : '';

      const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();

      const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));
      const subjectMatch = subjectFilters.some(f => subject.toLowerCase().includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));

      if ((senderMatch || subjectMatch) && filterAfterTimestamp > 0) {
        const emailTime = parseEmailDate(item);
        if (emailTime > 0 && emailTime < filterAfterTimestamp) {
          log(`Step ${step}: Skipping old email (date: ${new Date(emailTime).toLocaleString()})`, 'info');
          continue;
        }
      }

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(subject + ' ' + ariaLabel);
        if (code && excludedCodeSet.has(code)) {
          log(`Step ${step}: Skipping explicitly excluded code: ${code}`, 'info');
          continue;
        }
        if (code && !seenCodes.has(code)) {
          seenCodes.add(code);
          await persistSeenCodes();
          const source = useFallback && itemKey && existingMailKeys.has(itemKey) ? 'fallback' : 'new';
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${subject.slice(0, 40)})`, 'ok');
          return { ok: true, code, emailTimestamp: Date.now(), mailId: id };
        } else if (code && seenCodes.has(code)) {
          log(`Step ${step}: Skipping already-seen code: ${code}`, 'info');
        }
      }
    }

    if (allowExistingMailFallback && attempt === fallbackAfter + 1) {
      log(`Step ${step}: No new emails after ${fallbackAfter} attempts, falling back to first match`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No new matching email found on 163 Mail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check inbox manually.'
  );
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try toolbar refresh button
  const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text, .nui-btn, button');
  for (const btn of toolbarBtns) {
    if (normalizeMail163Text(btn.textContent) === MAIL163_REFRESH_LABEL) {
      simulateClick(btn.closest('.nui-btn') || btn);
      console.log(MAIL163_PREFIX, 'Clicked refresh button');
      await sleep(800);
      return;
    }
  }

  // Fallback: click mailbox entry
  const shouXinBtns = document.querySelectorAll('.ra0');
  for (const btn of shouXinBtns) {
    if (normalizeMail163Text(btn.textContent).includes(MAIL163_RECEIVE_LABEL)) {
      simulateClick(btn);
      console.log(MAIL163_PREFIX, 'Clicked mailbox entry');
      await sleep(800);
      return;
    }
  }

  console.log(MAIL163_PREFIX, 'Could not find refresh button');
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

} // end of isTopFrame else block
