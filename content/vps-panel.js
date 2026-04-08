// content/vps-panel.js — Content script for VPS panel (steps 1, 9)
// Injected on: VPS panel (user-configured URL)
// Supports both:
// - Cli-Proxy-API-Management-Center
// - codeProxy (/manage/* deployment)

console.log('[MultiPage:vps-panel] Content script loaded on', location.href);

const VPS_TYPE_CPAMC = 'Cli-Proxy-API-Management-Center';
const VPS_TYPE_CODE_PROXY = 'codeProxy';

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP') {
    resetStopState();
    handleStep(message.step, message.payload).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleStep(step, payload) {
  switch (step) {
    case 1:
      return await step1_getOAuthLink(payload);
    case 9:
      return await step9_vpsVerify(payload);
    default:
      throw new Error(`vps-panel.js does not handle step ${step}`);
  }
}

async function resolveVpsType(payload) {
  if (payload?.vpsType) return normalizeVpsType(payload.vpsType);
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    return normalizeVpsType(state?.vpsType);
  } catch {
    return VPS_TYPE_CPAMC;
  }
}

function normalizeVpsType(value) {
  return value === VPS_TYPE_CODE_PROXY ? VPS_TYPE_CODE_PROXY : VPS_TYPE_CPAMC;
}

function getVpsAdapter(vpsType) {
  return vpsType === VPS_TYPE_CODE_PROXY ? codeProxyAdapter : cpamcAdapter;
}

function extractHttpUrl(text) {
  const match = String(text || '').match(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
  return match ? match[0] : null;
}

function ensureOAuthUrlStateIsValid(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`OAuth URL is not a valid URL: ${String(rawUrl || '').slice(0, 120)}`);
  }

  const state = parsed.searchParams.get('state');
  if (!state) {
    throw new Error('OAuth URL missing required "state" parameter.');
  }

  if (/[^\x20-\x7E]/.test(state)) {
    throw new Error(
      'OAuth URL state contains non-ASCII characters (likely UI text contamination). ' +
      'Please retry Step 1.'
    );
  }

  return parsed.toString();
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function findButtonByText(root, pattern) {
  if (!root) return null;
  const buttons = root.querySelectorAll('button');
  for (const button of buttons) {
    if (pattern.test(normalizeText(button.textContent))) {
      return button;
    }
  }
  return null;
}

function findInputByHint(root, pattern) {
  if (!root) return null;
  const inputs = root.querySelectorAll('input');
  for (const input of inputs) {
    const hint = `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`.trim();
    if (pattern.test(hint)) return input;
  }
  return null;
}

async function waitForCardByTitle(titlePattern, timeout = 30000) {
  const titleEl = await waitForElementByText('h3, .card-header, [class*="cardTitle"]', titlePattern, timeout);
  return titleEl.closest('section, .card, [class*="card"]') || titleEl.parentElement || document;
}

async function waitForAuthUrlInCard(card, timeout = 15000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeout) {
    throwIfStopped();

    const directUrlEl = card.querySelector('[class*="authUrlValue"], [data-testid*="oauth"], a[href^="http"]');
    if (directUrlEl) {
      const href = directUrlEl.getAttribute('href');
      if (href && href.startsWith('http')) return href;
      const fromDirectText = extractHttpUrl(directUrlEl.textContent);
      if (fromDirectText) return fromDirectText;
    }

    const fromCardText = extractHttpUrl(card.textContent);
    if (fromCardText) return fromCardText;

    await sleep(200);
  }

  throw new Error('Auth URL did not appear after clicking start button. URL: ' + location.href);
}

async function waitForCallbackInputInCard(card, timeout = 10000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeout) {
    throwIfStopped();

    const bySelector = card.querySelector(
      '[class*="callbackSection"] input.input, ' +
      '[class*="callbackSection"] input, ' +
      'input[placeholder*="localhost"], ' +
      'input[placeholder*="callback"], ' +
      'input[placeholder*="回调"]'
    );
    if (bySelector) return bySelector;

    const byHint = findInputByHint(card, /callback|回调|localhost/i);
    if (byHint) return byHint;

    await sleep(200);
  }

  throw new Error('Could not find callback URL input on VPS panel. URL: ' + location.href);
}

async function waitForSubmitButtonInCard(card, inputEl, timeout = 6000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeout) {
    throwIfStopped();

    const nearInput = inputEl?.closest('div, section, form');
    const nearButton = findButtonByText(nearInput, /提交回调|submit\s*callback|提交|submit/i);
    if (nearButton) return nearButton;

    const cardButton = findButtonByText(card, /提交回调|submit\s*callback/i);
    if (cardButton) return cardButton;

    await sleep(160);
  }

  throw new Error('Could not find callback submit button on VPS panel. URL: ' + location.href);
}

async function waitForSubmitResultInCard(card, timeout = 30000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeout) {
    throwIfStopped();

    const statusEl = card.querySelector(
      '.status-badge, [class*="status"], [class*="text-emerald"], [class*="text-rose"]'
    );
    const statusText = normalizeText(statusEl?.textContent || '');
    const fullText = normalizeText(card.textContent || '');
    const text = `${statusText} ${fullText}`.trim();

    if (/认证成功|已提交|submitted|authorization\s*success|status:\s*success|已成功/i.test(text)) {
      return { status: 'success', detail: statusText || 'success' };
    }
    if (/提交回调失败|submit\s*callback\s*failed|failed|错误|error|invalid/i.test(statusText)) {
      return { status: 'error', detail: statusText || 'error' };
    }

    await sleep(260);
  }

  return { status: 'timeout', detail: 'No explicit success status detected yet.' };
}

const cpamcAdapter = {
  async findCodexCard(timeout = 30000) {
    const header = await waitForElementByText('.card-header', /codex/i, timeout);
    return header.closest('.card') || header.parentElement || document;
  },
  findStartButton(card) {
    return card.querySelector('.card-header button.btn.btn-primary, .card-header button.btn, .card-header button');
  },
  async waitAuthUrl(card) {
    return waitForAuthUrlInCard(card, 15000);
  },
  async findCallbackInput(card) {
    return waitForCallbackInputInCard(card, 10000);
  },
  async findSubmitButton(card, inputEl) {
    return waitForSubmitButtonInCard(card, inputEl, 5000);
  },
  async waitSubmitResult(card) {
    return waitForSubmitResultInCard(card, 30000);
  },
};

const codeProxyAdapter = {
  async findCodexCard(timeout = 30000) {
    return waitForCardByTitle(/codex\s*oauth|codex/i, timeout);
  },
  findStartButton(card) {
    return findButtonByText(card, /开始授权|start\s*authorization|login/i);
  },
  async waitAuthUrl(card) {
    return waitForAuthUrlInCard(card, 15000);
  },
  async findCallbackInput(card) {
    return waitForCallbackInputInCard(card, 10000);
  },
  async findSubmitButton(card, inputEl) {
    return waitForSubmitButtonInCard(card, inputEl, 6000);
  },
  async waitSubmitResult(card) {
    return waitForSubmitResultInCard(card, 30000);
  },
};

// ============================================================
// Step 1: Get OAuth Link
// ============================================================

async function step1_getOAuthLink(payload) {
  const vpsType = await resolveVpsType(payload);
  const adapter = getVpsAdapter(vpsType);
  log(`Step 1: Using VPS adapter: ${vpsType}`);
  log('Step 1: Waiting for VPS panel to load (auto-login may take a moment)...');

  let card = null;
  try {
    card = await adapter.findCodexCard(30000);
    log('Step 1: Found Codex OAuth card');
  } catch {
    throw new Error(
      `Codex OAuth card did not appear after 30s (${vpsType}). ` +
      'Page may still be loading or not logged in. Current URL: ' + location.href
    );
  }

  const startButton = adapter.findStartButton(card);
  if (!startButton) {
    throw new Error(`Found Codex OAuth card but no start button (${vpsType}). URL: ` + location.href);
  }

  if (startButton.disabled) {
    log('Step 1: Start button is disabled (already loading), waiting for auth URL...');
  } else {
    await humanPause(500, 1400);
    simulateClick(startButton);
    log('Step 1: Clicked start button, waiting for auth URL...');
  }

  const oauthUrl = await adapter.waitAuthUrl(card);
  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`Invalid OAuth URL found: "${String(oauthUrl || '').slice(0, 50)}".`);
  }

  const validOauthUrl = ensureOAuthUrlStateIsValid(oauthUrl);

  log(`Step 1: OAuth URL obtained: ${validOauthUrl.slice(0, 80)}...`, 'ok');
  reportComplete(1, { oauthUrl: validOauthUrl });
}

// ============================================================
// Step 9: VPS Verify — paste localhost URL and submit
// ============================================================

async function step9_vpsVerify(payload) {
  const vpsType = await resolveVpsType(payload);
  const adapter = getVpsAdapter(vpsType);

  let localhostUrl = payload?.localhostUrl;
  if (!localhostUrl) {
    log('Step 9: localhostUrl not in payload, fetching from state...');
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    localhostUrl = state.localhostUrl;
  }
  if (!localhostUrl) {
    throw new Error('No localhost URL found. Complete step 8 first.');
  }
  log(`Step 9: Using VPS adapter: ${vpsType}`);
  log(`Step 9: Got localhostUrl: ${localhostUrl.slice(0, 60)}...`);
  log('Step 9: Looking for callback URL input...');

  const card = await adapter.findCodexCard(15000);
  const urlInput = await adapter.findCallbackInput(card);

  await humanPause(600, 1500);
  fillInput(urlInput, localhostUrl);
  log(`Step 9: Filled callback URL: ${localhostUrl.slice(0, 80)}...`);

  const submitBtn = await adapter.findSubmitButton(card, urlInput);
  await humanPause(450, 1200);
  simulateClick(submitBtn);
  log('Step 9: Clicked callback submit button, waiting for authentication result...');

  const result = await adapter.waitSubmitResult(card);
  if (result.status === 'success') {
    log('Step 9: Authentication successful!', 'ok');
  } else if (result.status === 'error') {
    log(`Step 9: Callback submit returned error state: "${result.detail}"`, 'warn');
  } else {
    log(`Step 9: ${result.detail}`, 'warn');
  }

  reportComplete(9);
}
