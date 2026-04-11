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
const MAIL163_LIST_MESSAGES_XML = '<?xml version="1.0"?><object><int name="fid">1</int><string name="order">date</string><boolean name="desc">true</boolean><int name="limit">20</int><int name="start">0</int><boolean name="skipLockedFolders">false</boolean><string name="topFlag">top</string><boolean name="returnTag">true</boolean><boolean name="returnTotal">true</boolean></object>';

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// Only operate in the top frame
if (!isTopFrame) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
} else {

// Track codes we've already seen — persisted in chrome.storage.session to survive script re-injection
let seenCodes = new Set();
let structuredApiProbeLogged = false;

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

function getMail163Sid() {
  try {
    const currentUrl = new URL(location.href);
    const sidFromQuery = currentUrl.searchParams.get('sid');
    if (sidFromQuery) return sidFromQuery;
  } catch {}

  const cookieMatch = document.cookie.match(/(?:^|;\s*)Coremail\.sid=([^;]+)/);
  return cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
}

function parseMail163ApiDate(value) {
  if (value == null || value === '') return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseCoremailXmlValue(node) {
  if (!node) return null;

  const tag = String(node.tagName || '').toLowerCase();
  const text = node.textContent || '';

  if (tag === 'string' || tag === 'date') return text;
  if (tag === 'int' || tag === 'number') {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : text;
  }
  if (tag === 'boolean') {
    return /^(?:true|1)$/i.test(text.trim());
  }
  if (tag === 'array') {
    return Array.from(node.children || []).map(child => parseCoremailXmlValue(child));
  }
  if (tag === 'object') {
    const result = {};
    for (const child of Array.from(node.children || [])) {
      const key = child.getAttribute('name');
      const value = parseCoremailXmlValue(child);
      if (!key) continue;

      if (Object.prototype.hasOwnProperty.call(result, key)) {
        const current = result[key];
        result[key] = Array.isArray(current) ? [...current, value] : [current, value];
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return text;
}

function isMail163LiteralWhitespace(char) {
  return /\s/.test(char);
}

function isMail163LiteralIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function isMail163LiteralIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

function parseMail163JsLiteral(rawText) {
  const text = String(rawText || '').trim();
  let index = 0;

  function peek(offset = 0) {
    return text[index + offset];
  }

  function skipWhitespace() {
    while (index < text.length && isMail163LiteralWhitespace(text[index])) {
      index += 1;
    }
  }

  function expect(char) {
    skipWhitespace();
    if (text[index] !== char) {
      throw new Error(`Expected "${char}" at position ${index}, got "${text[index] || 'EOF'}"`);
    }
    index += 1;
  }

  function parseString() {
    skipWhitespace();
    const quote = text[index];
    if (quote !== '\'' && quote !== '"') {
      throw new Error(`Expected string at position ${index}`);
    }

    index += 1;
    let result = '';
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        const next = text[index + 1];
        if (next == null) break;
        if (next === 'n') result += '\n';
        else if (next === 'r') result += '\r';
        else if (next === 't') result += '\t';
        else result += next;
        index += 2;
        continue;
      }
      if (char === quote) {
        index += 1;
        return result;
      }
      result += char;
      index += 1;
    }

    throw new Error('Unterminated string literal.');
  }

  function parseIdentifier() {
    skipWhitespace();
    if (!isMail163LiteralIdentifierStart(peek())) {
      throw new Error(`Expected identifier at position ${index}`);
    }

    const start = index;
    index += 1;
    while (index < text.length && isMail163LiteralIdentifierPart(peek())) {
      index += 1;
    }
    return text.slice(start, index);
  }

  function parseNumber() {
    skipWhitespace();
    const start = index;
    if (peek() === '-') index += 1;
    while (/\d/.test(peek() || '')) index += 1;
    if (peek() === '.') {
      index += 1;
      while (/\d/.test(peek() || '')) index += 1;
    }
    const raw = text.slice(start, index);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid number literal "${raw}" at position ${start}`);
    }
    return value;
  }

  function consumeKeyword(keyword) {
    skipWhitespace();
    if (text.slice(index, index + keyword.length) !== keyword) return false;
    const next = text[index + keyword.length];
    if (next && isMail163LiteralIdentifierPart(next)) return false;
    index += keyword.length;
    return true;
  }

  function parseDateConstructor() {
    const identifier = parseIdentifier();
    if (identifier !== 'new') {
      throw new Error(`Unsupported identifier "${identifier}" at position ${index}`);
    }

    const ctor = parseIdentifier();
    if (ctor !== 'Date') {
      throw new Error(`Unsupported constructor "${ctor}" in mail-163 response.`);
    }

    expect('(');
    const args = [];
    skipWhitespace();
    if (peek() !== ')') {
      while (true) {
        args.push(parseValue());
        skipWhitespace();
        if (peek() === ',') {
          index += 1;
          continue;
        }
        break;
      }
    }
    expect(')');

    const numericArgs = args.map((item) => Number(item));
    if (numericArgs.some((item) => !Number.isFinite(item))) {
      throw new Error('new Date(...) arguments are not numeric.');
    }
    return new Date(...numericArgs);
  }

  function parseArray() {
    expect('[');
    const result = [];
    skipWhitespace();
    if (peek() === ']') {
      index += 1;
      return result;
    }

    while (index < text.length) {
      result.push(parseValue());
      skipWhitespace();
      const current = peek();
      if (current === ',') {
        index += 1;
        continue;
      }
      if (current === ']') {
        index += 1;
        return result;
      }
      throw new Error(`Unexpected token "${current || 'EOF'}" in array at position ${index}`);
    }

    throw new Error('Unterminated array literal.');
  }

  function parseObjectKey() {
    skipWhitespace();
    const current = peek();
    if (current === '\'' || current === '"') {
      return parseString();
    }
    return parseIdentifier();
  }

  function parseObject() {
    expect('{');
    const result = {};
    skipWhitespace();
    if (peek() === '}') {
      index += 1;
      return result;
    }

    while (index < text.length) {
      const key = parseObjectKey();
      expect(':');
      result[key] = parseValue();
      skipWhitespace();
      const current = peek();
      if (current === ',') {
        index += 1;
        continue;
      }
      if (current === '}') {
        index += 1;
        return result;
      }
      throw new Error(`Unexpected token "${current || 'EOF'}" in object at position ${index}`);
    }

    throw new Error('Unterminated object literal.');
  }

  function parseValue() {
    skipWhitespace();
    const current = peek();
    if (current === '{') return parseObject();
    if (current === '[') return parseArray();
    if (current === '\'' || current === '"') return parseString();
    if (current === '-' || /\d/.test(current || '')) return parseNumber();

    if (consumeKeyword('true')) return true;
    if (consumeKeyword('false')) return false;
    if (consumeKeyword('null')) return null;
    if (consumeKeyword('undefined')) return null;

    if (text.slice(index, index + 3) === 'new' && !isMail163LiteralIdentifierPart(text[index + 3] || '')) {
      return parseDateConstructor();
    }

    throw new Error(`Unsupported token "${current || 'EOF'}" at position ${index}`);
  }

  const value = parseValue();
  skipWhitespace();
  if (peek() === ';') {
    index += 1;
    skipWhitespace();
  }
  if (index < text.length) {
    throw new Error(`Unexpected trailing content at position ${index}`);
  }
  return value;
}

function parseMail163StructuredResponse(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error('mail-163 listMessages response is empty.');
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return parseMail163JsLiteral(trimmed);
    } catch (err) {
      throw new Error(`mail-163 JS literal parse failed: ${err?.message || err}`);
    }
  }

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(trimmed, 'text/xml');
  if (xmlDoc.querySelector('parsererror')) {
    throw new Error('mail-163 listMessages response is not parseable XML.');
  }

  return parseCoremailXmlValue(xmlDoc.documentElement);
}

function collectMail163ApiMessages(value, bucket = []) {
  if (!value) return bucket;

  if (Array.isArray(value)) {
    value.forEach(item => collectMail163ApiMessages(item, bucket));
    return bucket;
  }

  if (typeof value !== 'object') return bucket;

  if (
    typeof value.id === 'string'
    && (typeof value.subject === 'string' || typeof value.from === 'string')
  ) {
    bucket.push(value);
    return bucket;
  }

  Object.values(value).forEach(item => collectMail163ApiMessages(item, bucket));
  return bucket;
}

function normalizeMail163StructuredMessage(message) {
  return {
    id: String(message.id || ''),
    from: String(message.from || ''),
    to: String(message.to || ''),
    subject: String(message.subject || ''),
    sentDate: parseMail163ApiDate(message.sentDate),
    receivedDate: parseMail163ApiDate(message.receivedDate),
    modifiedDate: parseMail163ApiDate(message.modifiedDate),
  };
}

async function fetchMail163StructuredInbox(step, options = {}) {
  const { logProbe = false } = options;
  const sid = getMail163Sid();
  if (!sid) {
    throw new Error('Coremail sid not found on current page.');
  }

  const requestUrl = new URL('/js6/s', location.origin);
  requestUrl.searchParams.set('sid', sid);
  requestUrl.searchParams.set('func', 'mbox:listMessages');
  requestUrl.searchParams.set('mbox_folder_enter', '1');
  requestUrl.searchParams.set('LeftNavfolder1Click', '1');

  const response = await fetch(requestUrl.toString(), {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'text/javascript, text/xml, application/xml, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({ var: MAIL163_LIST_MESSAGES_XML }).toString(),
  });

  const rawText = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    throw new Error(`mail-163 listMessages fetch failed: HTTP ${response.status}`);
  }

  let parsed = null;
  try {
    parsed = parseMail163StructuredResponse(rawText);
  } catch (err) {
    const preview = rawText.slice(0, 180).replace(/\s+/g, ' ').trim();
    throw new Error(
      `${err?.message || err} (content-type=${contentType || 'unknown'}, preview=${preview})`
    );
  }

  const messages = collectMail163ApiMessages(parsed).map(normalizeMail163StructuredMessage);

  if (logProbe && !structuredApiProbeLogged) {
    structuredApiProbeLogged = true;
    const first = messages[0] || null;
    if (first) {
      log(
        `Step ${step}: 163 structured inbox probe OK (${messages.length} msgs). First subject="${first.subject.slice(0, 40)}", sent=${first.sentDate || 0}, received=${first.receivedDate || 0}`,
        'info'
      );
    } else {
      log(`Step ${step}: 163 structured inbox probe OK, but no messages were returned.`, 'info');
    }
  }

  return messages;
}

function buildMail163StructuredMessageMap(messages = []) {
  const byId = new Map();
  for (const message of messages) {
    if (message?.id) {
      byId.set(message.id, message);
    }
  }
  return byId;
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
  let structuredFetchFailed = false;
  try {
    await fetchMail163StructuredInbox(step, { logProbe: true });
  } catch (err) {
    structuredFetchFailed = true;
    const message = err?.message || String(err);
    log(`Step ${step}: 163 structured inbox probe failed: ${message}`, 'warn');
  }

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

    let structuredMessages = [];
    try {
      structuredMessages = await fetchMail163StructuredInbox(step);
    } catch (err) {
      if (!structuredFetchFailed) {
        structuredFetchFailed = true;
        const message = err?.message || String(err);
        log(`Step ${step}: Structured inbox refresh failed, falling back to DOM time: ${message}`, 'warn');
      }
    }
    const structuredMessageMap = buildMail163StructuredMessageMap(structuredMessages);
    const allItems = findMailItems();
    const useFallback = allowExistingMailFallback && attempt > fallbackAfter;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';
      const itemKey = getMailItemKey(item);
      const structuredMessage = id ? structuredMessageMap.get(id) : null;

      if (!useFallback && itemKey && existingMailKeys.has(itemKey)) continue;

      const senderEl = item.querySelector('.nui-user');
      const sender = senderEl ? senderEl.textContent.toLowerCase() : '';

      const subjectEl = item.querySelector('span.da0');
      const subject = subjectEl ? subjectEl.textContent : '';

      const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();
      const structuredFrom = String(structuredMessage?.from || '').toLowerCase();
      const structuredSubject = String(structuredMessage?.subject || '');
      const combinedSubject = `${subject} ${structuredSubject}`.trim();
      const combinedMetadata = `${ariaLabel} ${structuredFrom}`.trim();

      const senderMatch = senderFilters.some((f) => {
        const needle = f.toLowerCase();
        return sender.includes(needle) || ariaLabel.includes(needle) || structuredFrom.includes(needle);
      });
      const subjectMatch = subjectFilters.some((f) => {
        const needle = f.toLowerCase();
        return combinedSubject.toLowerCase().includes(needle) || combinedMetadata.includes(needle);
      });

      if ((senderMatch || subjectMatch) && filterAfterTimestamp > 0) {
        const emailTime = structuredMessage?.sentDate || parseEmailDate(item);
        if (emailTime > 0 && emailTime < filterAfterTimestamp) {
          const timeSource = structuredMessage?.sentDate ? 'sentDate' : 'dom-date';
          log(
            `Step ${step}: Skipping old email via ${timeSource} (${new Date(emailTime).toLocaleString()})`,
            'info'
          );
          continue;
        }
      }

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(`${combinedSubject} ${combinedMetadata}`);
        if (code && excludedCodeSet.has(code)) {
          log(`Step ${step}: Skipping explicitly excluded code: ${code}`, 'info');
          continue;
        }
        if (code && !seenCodes.has(code)) {
          seenCodes.add(code);
          await persistSeenCodes();
          const source = useFallback && itemKey && existingMailKeys.has(itemKey) ? 'fallback' : 'new';
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${combinedSubject.slice(0, 40)})`, 'ok');
          return {
            ok: true,
            code,
            emailTimestamp: structuredMessage?.sentDate || structuredMessage?.receivedDate || Date.now(),
            mailId: id,
          };
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
