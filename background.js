// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const VPS_TYPE_CPAMC = 'Cli-Proxy-API-Management-Center';
const VPS_TYPE_CODE_PROXY = 'codeProxy';
const AUTH_FLOW_MAX_RECOVERY_ATTEMPTS = 5;
const DUCK_AUTO_FETCH_MAX_ATTEMPTS = 5;
const DEFAULT_STEP_COMPLETION_TIMEOUT_MS = 120000;
const VERIFICATION_STEP_COMPLETION_TIMEOUT_MS = 360000;
const VERIFICATION_POLL_SETTINGS = {
  maxAttempts: 45,
  intervalMs: 5000,
  fallbackAfterAttempts: 42,
  freemailRelaxAfterAttempts: 43,
};
const PRE_RESEND_VERIFICATION_POLL_ATTEMPTS = 8; // ~40s before we fall back to clicking "resend email"
const OPENAI_SITE_DATA_ORIGINS = [
  'https://openai.com',
  'https://chatgpt.com',
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://accounts.openai.com',
];
const OPENAI_SITE_DATA_TYPES = {
  cache: true,
  cacheStorage: true,
  cookies: true,
  indexedDB: true,
  localStorage: true,
  serviceWorkers: true,
  webSQL: true,
};

initializeSessionStorageAccess();

let automationWindowId = null;

async function ensureAutomationWindowId() {
  if (automationWindowId != null) {
    try {
      await chrome.windows.get(automationWindowId);
      return automationWindowId;
    } catch {
      automationWindowId = null;
    }
  }
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (entry.tabId) {
      try {
        const tab = await chrome.tabs.get(entry.tabId);
        automationWindowId = tab.windowId;
        return automationWindowId;
      } catch {}
    }
  }
  const win = await chrome.windows.getLastFocused();
  automationWindowId = win.id;
  return automationWindowId;
}


// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: 'https://ddvcode.zeabur.app/manage/oauth',
  vpsType: VPS_TYPE_CODE_PROXY,
  customPassword: '',
  mailProvider: 'qq', // 'qq' or '163'
  inbucketHost: '',
  inbucketMailbox: '',
  freemailApiUrl: '',
  freemailJwtToken: '',
  freemailDomain: '',
  lastSignupCode: null,
};

function normalizeVpsType(value) {
  return value === VPS_TYPE_CODE_PROXY ? VPS_TYPE_CODE_PROXY : VPS_TYPE_CPAMC;
}

async function getState() {
  const state = await chrome.storage.session.get(null);
  return { ...DEFAULT_STATE, ...state };
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

async function setEmailState(email) {
  await setState({ email });
  broadcastDataUpdate({ email });
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get([
    'seenCodes',
    'seenInbucketMailIds',
    'accounts',
    'tabRegistry',
    'vpsUrl',
    'vpsType',
    'customPassword',
    'mailProvider',
    'inbucketHost',
    'inbucketMailbox',
    'freemailApiUrl',
    'freemailJwtToken',
    'freemailDomain',
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    vpsUrl: prev.vpsUrl || DEFAULT_STATE.vpsUrl,
    vpsType: prev.vpsType ? normalizeVpsType(prev.vpsType) : DEFAULT_STATE.vpsType,
    customPassword: prev.customPassword || '',
    mailProvider: prev.mailProvider || DEFAULT_STATE.mailProvider,
    inbucketHost: prev.inbucketHost || '',
    inbucketMailbox: prev.inbucketMailbox || '',
    freemailApiUrl: prev.freemailApiUrl || '',
    freemailJwtToken: prev.freemailJwtToken || '',
    freemailDomain: prev.freemailDomain || '',
  });
}

async function clearOpenAiSiteDataForNewRun(contextLabel = 'new run') {
  if (!chrome.browsingData?.remove) {
    await addLog(`OpenAI site data cleanup unavailable before ${contextLabel}: browsingData permission missing.`, 'warn');
    return;
  }

  await addLog(`Clearing OpenAI site cookies/cache before ${contextLabel}...`, 'info');
  try {
    await chrome.browsingData.remove(
      {
        since: 0,
        origins: OPENAI_SITE_DATA_ORIGINS,
      },
      OPENAI_SITE_DATA_TYPES
    );
    await addLog(`OpenAI site cookies/cache cleared before ${contextLabel}.`, 'ok');
  } catch (err) {
    await addLog(`Failed to clear OpenAI site data before ${contextLabel}: ${err.message}`, 'warn');
  }
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

    const registry = await getTabRegistry();
    if (sameUrl) {
      await chrome.tabs.update(tabId, { active: true });
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

      if (shouldReloadOnReuse) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        await chrome.tabs.reload(tabId);

        await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
          const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      // For dynamically injected pages like the VPS panel, re-inject immediately.
      if (options.inject) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
        await new Promise(r => setTimeout(r, 500));
      }

      return tabId;
    }

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (VPS panel), re-inject after navigation
    if (options.inject) {
      if (options.injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [options.injectSource],
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 500));

    return tabId;
  }

  // Create new tab in the automation window
  const wid = await ensureAutomationWindowId();
  const tab = await chrome.tabs.create({ url, active: true, windowId: wid });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

function buildResetUpdatesFromStep(step) {
  const updates = {};

  if (step <= 1) {
    updates.oauthUrl = null;
    updates.flowStartTime = null;
  }
  if (step <= 3) {
    updates.password = null;
  }
  if (step <= 4) {
    updates.lastEmailTimestamp = null;
    updates.lastSignupCode = null;
  }
  if (step <= 8) {
    updates.localhostUrl = null;
  }

  return updates;
}

async function invalidateFutureState(step, reason = '') {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  const changedSteps = [];

  for (let index = step + 1; index <= 9; index++) {
    if (statuses[index] !== 'pending') {
      statuses[index] = 'pending';
      changedSteps.push(index);
    }
  }

  const updates = {
    stepStatuses: statuses,
    ...buildResetUpdatesFromStep(step),
  };

  await setState(updates);

  for (const changedStep of changedSteps) {
    chrome.runtime.sendMessage({
      type: 'STEP_STATUS_CHANGED',
      payload: { step: changedStep, status: 'pending' },
    }).catch(() => {});
  }

  const dataPayload = {};
  if (Object.prototype.hasOwnProperty.call(updates, 'oauthUrl')) dataPayload.oauthUrl = updates.oauthUrl;
  if (Object.prototype.hasOwnProperty.call(updates, 'password')) dataPayload.password = updates.password;
  if (Object.prototype.hasOwnProperty.call(updates, 'localhostUrl')) dataPayload.localhostUrl = updates.localhostUrl;
  if (Object.keys(dataPayload).length) {
    broadcastDataUpdate(dataPayload);
  }

  if (changedSteps.length || reason) {
    const detail = changedSteps.length ? `reset future steps ${changedSteps.join(', ')}` : 'cleared related future state';
    await addLog(`Step ${step}: ${detail}${reason ? ` (${reason})` : ''}`, 'info');
  }
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 8 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 8 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

let stopRequested = false;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`Step ${message.step} stopped by user`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
        notifyStepError(message.step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      const currentState = await getState();
      if (step === 1 && currentState.currentStep === 0) {
        await clearOpenAiSiteDataForNewRun('manual step 1 start');
      }
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      if (step >= 7 && step <= 9) {
        await executeManualStepWithRecovery(step);
      } else {
        await executeStep(step);
      }
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.vpsType !== undefined) updates.vpsType = normalizeVpsType(message.payload.vpsType);
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      if (message.payload.inbucketHost !== undefined) updates.inbucketHost = message.payload.inbucketHost;
      if (message.payload.inbucketMailbox !== undefined) updates.inbucketMailbox = message.payload.inbucketMailbox;
      if (message.payload.freemailApiUrl !== undefined) updates.freemailApiUrl = message.payload.freemailApiUrl;
      if (message.payload.freemailJwtToken !== undefined) updates.freemailJwtToken = message.payload.freemailJwtToken;
      if (message.payload.freemailDomain !== undefined) updates.freemailDomain = message.payload.freemailDomain;
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setEmailState(message.payload.email);
      return { ok: true, email: message.payload.email };
    }

    case 'FETCH_DUCK_EMAIL': {
      clearStopRequest();
      const email = await fetchDuckEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'FETCH_PROVIDER_EMAIL': {
      clearStopRequest();
      const state = await getState();
      const provider = message.payload?.provider || state.mailProvider || '163';
      const email = await fetchEmailForProvider(provider, state, message.payload || {});
      return { ok: true, email };
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function getStepCompletionTimeout(step) {
  return step === 4 || step === 7
    ? VERIFICATION_STEP_COMPLETION_TIMEOUT_MS
    : DEFAULT_STEP_COMPLETION_TIMEOUT_MS;
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('Stop requested. Cancelling current operations...', 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  await markRunningStepsStopped();
  autoRunActive = false;
  await setState({ autoRunning: false });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await invalidateFutureState(step);
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);
  await humanStepDelay();

  if (step === 1) {
    await setState({ flowStartTime: Date.now() });
  }

  const state = await getState();

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`Step ${step} stopped by user`, 'warn');
      throw err;
    }
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  throwIfStopped();
  const promise = waitForStepComplete(step, getStepCompletionTimeout(step));
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

function withStepContext(step, err) {
  if (err && typeof err === 'object' && err.step == null) {
    err.step = step;
  }
  return err;
}

function isRecoverableAuthError(step, err) {
  const message = String(err?.message || err || '');
  if (!message) return false;

  if (step === 7) {
    return /verification code|验证码|not found in time|Could not find verification code input|No verification code provided/i.test(message);
  }
  if (step === 8) {
    return /Localhost redirect not captured|debugger click|继续" button|OAuth consent|redirect/i.test(message);
  }
  if (step === 9) {
    return /Timeout waiting for OAuth callback|OAuth callback timeout|callback timeout|认证失败[:：]?\s*Timeout waiting for OAuth callback/i.test(message);
  }
  return false;
}

async function executeAuthorizationFlowWithRecovery(maxAttempts = AUTH_FLOW_MAX_RECOVERY_ATTEMPTS) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await executeStepAndWait(6, 3000);
      try {
        await executeStepAndWait(7, 2000);
      } catch (err) {
        throw withStepContext(7, err);
      }
      try {
        await executeStepAndWait(8, 2000);
      } catch (err) {
        throw withStepContext(8, err);
      }
      try {
        await executeStepAndWait(9, 1000);
      } catch (err) {
        throw withStepContext(9, err);
      }
      return;
    } catch (err) {
      const failedStep = err?.step || 6;
      if (attempt >= maxAttempts || !isRecoverableAuthError(failedStep, err)) {
        throw err;
      }

      await addLog(
        `Auth recovery ${attempt}/${maxAttempts}: step ${failedStep} failed with recoverable error: ${err.message}. Restarting from step 6...`,
        'warn'
      );
      await invalidateFutureState(6, 'authorization recovery');
    }
  }
}

async function executeManualStepWithRecovery(step) {
  try {
    await executeStep(step);
  } catch (err) {
    if (step >= 7 && step <= 9 && isRecoverableAuthError(step, err)) {
      await addLog(`Step ${step}: recoverable auth error detected. Restarting authorization from step 6...`, 'warn');
      await executeAuthorizationFlowWithRecovery();
      return;
    }
    throw err;
  }
}

async function fetchDuckEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Duck Mail: Opening autofill settings (${generateNew ? 'generate new' : 'reuse current'})...`);
  await reuseOrCreateTab('duck-mail', DUCK_AUTOFILL_URL);

  const result = await sendToContentScript('duck-mail', {
    type: 'FETCH_DUCK_EMAIL',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('Duck email not returned.');
  }

  await setEmailState(result.email);
  await addLog(`Duck Mail: ${result.generated ? 'Generated' : 'Loaded'} ${result.email}`, 'ok');
  return result.email;
}

function normalizeFreemailApiUrl(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';
  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return '';
  }
}

function parseFreemailMessageTimestamp(message) {
  const candidates = [
    message?.timestamp,
    message?.createdAt,
    message?.created_at,
    message?.receivedAt,
    message?.received_at,
    message?.date,
    message?.time,
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 1e12 ? candidate * 1000 : candidate;
    }
    if (typeof candidate === 'string') {
      const numeric = Number(candidate);
      if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

function extractFreemailVerificationCode(message) {
  const directFields = [
    message?.verification_code,
    message?.verificationCode,
    message?.code,
    message?.otp,
    message?.captcha,
    message?.verify_code,
  ];
  for (const fieldValue of directFields) {
    const candidate = String(fieldValue || '').trim();
    if (!candidate || candidate.toLowerCase() === 'none') continue;
    const exact = candidate.match(/(^|[^0-9])(\d{6})([^0-9]|$)/);
    if (exact) return exact[2];
  }

  const text = [
    message?.from,
    message?.sender,
    message?.preview,
    message?.subject,
    message?.text,
    message?.body,
    message?.content,
    message?.html,
    message?.raw,
  ].map((item) => String(item || '')).join(' ');

  const semanticPatterns = [
    /(?:verification\s+code|one[-\s]*time\s+(?:password|code)|security\s+code|login\s+code|验证码|校验码|动态码|認證碼|驗證碼)[^0-9]{0,30}(\d{6})/i,
    /\bcode\b[^0-9]{0,12}(\d{6})/i,
    /(^|[^#\d])(\d{6})(?!\d)/,
  ];
  for (const pattern of semanticPatterns) {
    const match = text.match(pattern);
    if (match) {
      const value = match[1] && /^\d{6}$/.test(match[1]) ? match[1] : match[2];
      if (value && /^\d{6}$/.test(value)) return value;
    }
  }
  return '';
}

function normalizeFreemailMessages(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [
    payload.data,
    payload.emails,
    payload.messages,
    payload.items,
    payload.list,
    payload.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function getFreemailMessageId(message) {
  const rawId = String(message?.id || message?._id || message?.messageId || message?.mail_id || '').trim();
  if (rawId) return rawId;
  try {
    return `hash:${JSON.stringify(message)}`;
  } catch {
    return `hash:${String(message)}`;
  }
}

async function fetchFreemailJson(state, path, params = {}, method = 'GET', body = null) {
  const apiBase = normalizeFreemailApiUrl(state.freemailApiUrl);
  if (!apiBase) {
    throw new Error('Freemail API URL is empty or invalid.');
  }

  const url = new URL(`${apiBase}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const headers = {
    Accept: 'application/json',
  };
  const jwtToken = (state.freemailJwtToken || '').trim();
  if (jwtToken) {
    headers.Authorization = `Bearer ${jwtToken}`;
  }
  if (body != null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  let text = '';
  try {
    payload = await response.json();
  } catch {
    try {
      text = await response.text();
    } catch {
      text = '';
    }
  }

  if (!response.ok) {
    const serverMsg = payload?.error || payload?.message || text || `HTTP ${response.status}`;
    throw new Error(`Freemail API request failed (${response.status}): ${serverMsg}`);
  }

  return payload;
}

async function resolveFreemailDomainIndex(state) {
  const preferredDomain = String(state.freemailDomain || '').trim().replace(/^@+/, '').toLowerCase();
  if (!preferredDomain) return null;

  try {
    const domainsPayload = await fetchFreemailJson(state, '/api/domains');
    const rawList = Array.isArray(domainsPayload)
      ? domainsPayload
      : (
        Array.isArray(domainsPayload?.domains)
          ? domainsPayload.domains
          : (Array.isArray(domainsPayload?.data) ? domainsPayload.data : [])
      );

    const domains = [];
    for (const item of rawList) {
      const value = typeof item === 'object'
        ? (item.domain || item.name || item.value || '')
        : item;
      const domain = String(value || '').trim().replace(/^@+/, '').toLowerCase();
      if (domain && !domains.includes(domain)) domains.push(domain);
    }

    const index = domains.findIndex((domain) => domain === preferredDomain);
    if (index === -1) {
      await addLog(`Freemail: configured domain "${preferredDomain}" not found in /api/domains. Falling back to default domain.`, 'warn');
      return 0;
    }
    return index;
  } catch (err) {
    await addLog(`Freemail: failed to resolve domain list (${err.message}). Falling back to default domain.`, 'warn');
    return 0;
  }
}

async function fetchFreemailEmail(state) {
  const params = {};
  const domainIndex = await resolveFreemailDomainIndex(state);
  if (domainIndex != null) {
    params.domainIndex = domainIndex;
  }

  const payload = await fetchFreemailJson(state, '/api/generate', params);
  const email = String(payload?.email || '').trim();
  if (!email.includes('@')) {
    throw new Error('Freemail API did not return a valid email.');
  }

  const preferredDomain = String(state.freemailDomain || '').trim().replace(/^@+/, '').toLowerCase();
  if (preferredDomain) {
    const actualDomain = email.split('@')[1]?.trim().toLowerCase() || '';
    if (actualDomain && actualDomain !== preferredDomain) {
      await addLog(`Freemail: expected domain ${preferredDomain}, received ${actualDomain}.`, 'warn');
    }
  }

  await setEmailState(email);
  await addLog(`Freemail: generated mailbox ${email}`, 'ok');
  return email;
}

async function pollFreemailVerificationCode(state, options = {}) {
  const mailbox = String(state.email || '').trim();
  if (!mailbox) {
    throw new Error('Freemail polling requires email address (Step 3).');
  }

  const {
    step = 4,
    filterAfterTimestamp = 0,
    maxAttempts = 20,
    intervalMs = 3000,
    excludeCodes = [],
    relaxTimestampAfterAttempts = Math.ceil(maxAttempts / 2),
  } = options;

  const seenMessageIds = new Set();
  const excludedCodeSet = new Set(
    (excludeCodes || []).map((item) => String(item || '').trim()).filter(Boolean)
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    const mailboxPayload = await fetchFreemailJson(state, '/api/emails', {
      mailbox,
      limit: 20,
    });
    let messages = normalizeFreemailMessages(mailboxPayload);
    if (!messages.length) {
      try {
        const emailPayload = await fetchFreemailJson(state, '/api/emails', {
          email: mailbox,
          limit: 20,
        });
        const fallbackMessages = normalizeFreemailMessages(emailPayload);
        if (fallbackMessages.length) {
          messages = fallbackMessages;
        }
      } catch {}
    }

    const relaxedTimestampFilter = attempt > relaxTimestampAfterAttempts;
    for (const message of messages) {
      const emailTimestamp = parseFreemailMessageTimestamp(message);
      if (
        !relaxedTimestampFilter
        && filterAfterTimestamp
        && emailTimestamp
        && emailTimestamp < filterAfterTimestamp
      ) {
        continue;
      }

      const messageId = getFreemailMessageId(message);
      if (messageId && seenMessageIds.has(messageId)) continue;
      if (messageId) seenMessageIds.add(messageId);

      const code = extractFreemailVerificationCode(message);
      if (!code) continue;
      if (excludedCodeSet.has(code)) continue;

      return {
        code,
        emailTimestamp: emailTimestamp || Date.now(),
        mailId: messageId || null,
      };
    }

    if (attempt < maxAttempts) {
      const mode = attempt > relaxTimestampAfterAttempts ? 'relaxed-time' : 'strict-time';
      await addLog(`Step ${step}: Freemail polling attempt ${attempt}/${maxAttempts} (${mode}), no new code yet...`, 'info');
      await sleepWithStop(intervalMs);
    }
  }

  throw new Error(`Step ${step}: Freemail verification code not found in time.`);
}

async function fetchEmailForProvider(provider, state, options = {}) {
  if (provider === 'freemail') {
    return fetchFreemailEmail(state);
  }
  return fetchDuckEmail(options);
}

async function fetchEmailForProviderWithRetries(provider, state, options = {}) {
  if (provider === 'freemail') {
    return fetchFreemailEmail(state);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= DUCK_AUTO_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        await addLog(`Duck Mail: retrying auto fetch (${attempt}/${DUCK_AUTO_FETCH_MAX_ATTEMPTS})...`, 'info');
      }
      return await fetchDuckEmail(options);
    } catch (err) {
      lastError = err;
      await addLog(`Duck Mail auto-fetch attempt ${attempt}/${DUCK_AUTO_FETCH_MAX_ATTEMPTS} failed: ${err.message}`, 'warn');
      if (attempt < DUCK_AUTO_FETCH_MAX_ATTEMPTS) {
        await sleepWithStop(1500);
      }
    }
  }

  throw lastError || new Error('Duck Mail auto-fetch failed.');
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  await setState({ autoRunning: true });

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    // Reset everything at the start of each run (keep VPS/mail settings)
    const prevState = await getState();
    const keepSettings = {
      vpsUrl: prevState.vpsUrl,
      vpsType: normalizeVpsType(prevState.vpsType),
      mailProvider: prevState.mailProvider,
      inbucketHost: prevState.inbucketHost,
      inbucketMailbox: prevState.inbucketMailbox,
      freemailApiUrl: prevState.freemailApiUrl,
      freemailJwtToken: prevState.freemailJwtToken,
      freemailDomain: prevState.freemailDomain,
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepWithStop(500);
    await clearOpenAiSiteDataForNewRun(`auto run ${run}/${totalRuns}`);

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    try {
      throwIfStopped();
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepAndWait(1, 2000);
      await executeStepAndWait(2, 2000);

      let emailReady = false;
      const provider = (prevState.mailProvider || '163').trim();
      try {
        const currentState = await getState();
        const autoEmail = await fetchEmailForProviderWithRetries(provider, currentState, { generateNew: true });
        const providerLabel = provider === 'freemail' ? 'Freemail' : 'Duck Mail';
        await addLog(`=== Run ${run}/${totalRuns} — ${providerLabel} email ready: ${autoEmail} ===`, 'ok');
        emailReady = true;
      } catch (err) {
        const providerLabel = provider === 'freemail' ? 'Freemail' : 'Duck Mail';
        await addLog(`${providerLabel} auto-fetch failed: ${err.message}`, 'warn');
      }

      if (!emailReady) {
        const providerHint = provider === 'freemail'
          ? 'fetch Freemail email or paste manually'
          : 'fetch Duck email or paste manually';
        await addLog(`=== Run ${run}/${totalRuns} PAUSED: ${providerHint}, then continue ===`, 'warn');
        chrome.runtime.sendMessage(status('waiting_email')).catch(() => {});

        // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
        await waitForResume();

        const resumedState = await getState();
        if (!resumedState.email) {
          await addLog('Cannot resume: no email address.', 'error');
          break;
        }
      }

      await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      const signupTabId = await getTabId('signup-page');
      if (signupTabId) {
        await chrome.tabs.update(signupTabId, { active: true });
      }

      await executeStepAndWait(3, 3000);
      await executeStepAndWait(4, 2000);
      await executeStepAndWait(5, 3000);
      await executeAuthorizationFlowWithRecovery();

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');

    } catch (err) {
      if (isStopError(err)) {
        await addLog(`Run ${run}/${totalRuns} stopped by user`, 'warn');
      } else {
        await addLog(`Run ${run}/${totalRuns} failed: ${err.message}`, 'error');
      }
      chrome.runtime.sendMessage(status('stopped')).catch(() => {});
      break; // Stop on error
    }
  }

  const completedRuns = autoRunCurrentRun;
  if (stopRequested) {
    await addLog(`=== Stopped after ${Math.max(0, completedRuns - 1)}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  }
  autoRunActive = false;
  await setState({ autoRunning: false });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
  }
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  if (!state.vpsUrl) {
    throw new Error('No VPS URL configured. Enter VPS address in Side Panel first.');
  }
  await addLog(`Step 1: Opening VPS panel...`);
  await reuseOrCreateTab('vps-panel', state.vpsUrl, {
    inject: ['content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true,
  });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: { vpsType: normalizeVpsType(state.vpsType) },
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL...`);
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  let email = String(state.email || '').trim();
  if (!email) {
    if (state.mailProvider === 'freemail') {
      await addLog('Step 3: No email provided, requesting one from Freemail...', 'info');
      email = await fetchFreemailEmail(state);
      state = { ...state, email };
    } else {
      throw new Error('No email address. Paste email in Side Panel first.');
    }
  }

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

  await addLog(
    `Step 3: Filling email ${email}, password ${state.customPassword ? 'customized' : 'generated'} (${password.length} chars)`
  );
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  if (provider === 'freemail') {
    return { source: 'freemail-api', label: 'Freemail API', apiDriven: true };
  }
  if (provider === 'inbucket') {
    const host = normalizeInbucketOrigin(state.inbucketHost);
    const mailbox = (state.inbucketMailbox || '').trim();
    if (!host) {
      return { error: 'Inbucket host is empty or invalid.' };
    }
    if (!mailbox) {
      return { error: 'Inbucket mailbox name is empty.' };
    }
    return {
      source: 'inbucket-mail',
      url: `${host}/m/${encodeURIComponent(mailbox)}/`,
      label: `Inbucket Mailbox (${mailbox})`,
      navigateOnReuse: true,
      inject: ['content/utils.js', 'content/inbucket-mail.js'],
      injectSource: 'inbucket-mail',
    };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

function getVerificationPollConfig(step) {
  if (step === 7) {
    return {
      codeLabel: 'login verification code',
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'],
      subjectFilters: ['verify', 'verification', 'code', '楠岃瘉', 'confirm', 'login'],
      tabClosedError: 'Auth page tab was closed. Cannot fill verification code.',
    };
  }

  return {
    codeLabel: 'verification code',
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'],
    subjectFilters: ['verify', 'verification', 'code', '楠岃瘉', 'confirm'],
    tabClosedError: 'Signup page tab was closed. Cannot fill verification code.',
  };
}

function isVerificationPollTimeoutError(err) {
  const message = String(err?.message || err || '');
  return /verification code not found in time|No new matching email found|No matching verification email found/i.test(message);
}

async function ensureMailChannelReady(mail, step, phaseLabel = '') {
  const phaseSuffix = phaseLabel ? ` (${phaseLabel})` : '';
  await addLog(`Step ${step}: Opening ${mail.label}${phaseSuffix}...`);

  // For mail tabs, only create if not alive; reusing avoids losing the current login session.
  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
      await chrome.tabs.update(tabId, { active: true });
    }
    return;
  }

  await reuseOrCreateTab(mail.source, mail.url, {
    inject: mail.inject,
    injectSource: mail.injectSource,
  });
}

async function pollVerificationCode(step, state, options = {}) {
  const {
    disableFallback = false,
    excludeCodes = [],
    filterAfterTimestamp = 0,
    maxAttempts = VERIFICATION_POLL_SETTINGS.maxAttempts,
    phaseLabel = '',
    relaxTimestampAfterAttempts = VERIFICATION_POLL_SETTINGS.freemailRelaxAfterAttempts,
    suppressStepError = false,
  } = options;

  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);

  const pollConfig = getVerificationPollConfig(step);
  await ensureMailChannelReady(mail, step, phaseLabel);

  if (mail.apiDriven) {
    return pollFreemailVerificationCode(state, {
      step,
      filterAfterTimestamp,
      maxAttempts,
      intervalMs: VERIFICATION_POLL_SETTINGS.intervalMs,
      relaxTimestampAfterAttempts,
      excludeCodes,
    });
  }

  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step,
    source: 'background',
    payload: {
      filterAfterTimestamp,
      senderFilters: pollConfig.senderFilters,
      subjectFilters: pollConfig.subjectFilters,
      targetEmail: state.email,
      maxAttempts,
      intervalMs: VERIFICATION_POLL_SETTINGS.intervalMs,
      fallbackAfterAttempts: VERIFICATION_POLL_SETTINGS.fallbackAfterAttempts,
      disableFallback,
      suppressStepError,
    },
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  return result;
}

async function fillVerificationCodeForStep(step, result) {
  if (!result?.code) return false;

  const pollConfig = getVerificationPollConfig(step);
  const stateUpdates = {};
  if (result.emailTimestamp) stateUpdates.lastEmailTimestamp = result.emailTimestamp;
  if (step === 4) stateUpdates.lastSignupCode = result.code;
  if (Object.keys(stateUpdates).length > 0) {
    await setState(stateUpdates);
  }

  await addLog(`Step ${step}: Got ${pollConfig.codeLabel}: ${result.code}`);

  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error(pollConfig.tabClosedError);
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await sendToContentScript('signup-page', {
    type: 'FILL_CODE',
    step,
    source: 'background',
    payload: { code: result.code },
  });
  return true;
}

async function pollVerificationCodeBeforeResend(step, state, options = {}) {
  try {
    const result = await pollVerificationCode(step, state, {
      ...options,
      disableFallback: true,
      maxAttempts: PRE_RESEND_VERIFICATION_POLL_ATTEMPTS,
      phaseLabel: 'initial mailbox wait',
      relaxTimestampAfterAttempts: PRE_RESEND_VERIFICATION_POLL_ATTEMPTS,
      suppressStepError: true,
    });

    if (!result?.code) return false;

    await addLog(`Step ${step}: Code arrived during the initial mailbox wait, skipping resend.`, 'ok');
    await fillVerificationCodeForStep(step, result);
    return true;
  } catch (err) {
    if (!isVerificationPollTimeoutError(err)) {
      throw err;
    }

    await addLog(
      `Step ${step}: No code arrived during the initial mailbox wait (~40s). Resending email and continuing to poll...`,
      'warn'
    );
    return false;
  }
}

function normalizeInbucketOrigin(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '';
  }
}

async function clickResendOnSignupPage(step) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return;

  await chrome.tabs.update(signupTabId, { active: true });
  await sleepWithStop(500);

  try {
    await sendToContentScript('signup-page', {
      type: 'CLICK_RESEND_EMAIL',
      step,
      source: 'background',
    });
  } catch (err) {
    await addLog(`Step ${step}: Resend click skipped: ${err.message}`, 'warn');
  }
}

async function executeStep4(state) {
  const stepStartTimestamp = Date.now();
  if (await pollVerificationCodeBeforeResend(4, state, { filterAfterTimestamp: stepStartTimestamp })) {
    return;
  }

  await clickResendOnSignupPage(4);

  const result = await pollVerificationCode(4, state, {
    filterAfterTimestamp: stepStartTimestamp,
    phaseLabel: 'post-resend wait',
  });
  await fillVerificationCodeForStep(4, result);
}
// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  await addLog(`Step 6: Opening OAuth URL for login...`);
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  const stepStartTimestamp = Date.now();
  const excludeCodes = state.lastSignupCode ? [state.lastSignupCode] : [];
  if (await pollVerificationCodeBeforeResend(7, state, {
    filterAfterTimestamp: stepStartTimestamp,
    excludeCodes,
  })) {
    return;
  }

  await clickResendOnSignupPage(7);

  const result = await pollVerificationCode(7, state, {
    filterAfterTimestamp: stepStartTimestamp,
    excludeCodes,
    phaseLabel: 'post-resend wait',
  });
  await fillVerificationCodeForStep(7, result);
}
// ============================================================
// Step 8: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  // Check if the signup tab already redirected to localhost before listener setup
  const signupTabIdEarly = await getTabId('signup-page');
  if (signupTabIdEarly) {
    try {
      const tab = await chrome.tabs.get(signupTabIdEarly);
      if (tab.url && (tab.url.startsWith('http://localhost') || tab.url.startsWith('http://127.0.0.1'))) {
        await addLog(`Step 8: Localhost redirect already captured: ${tab.url}`, 'ok');
        await setState({ localhostUrl: tab.url });
        broadcastDataUpdate({ localhostUrl: tab.url });
        return;
      }
    } catch {}
  }

  await addLog('Step 8: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;

    const isLocalhostUrl = (url) =>
      url && (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1'));

    const cleanupListeners = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        chrome.webNavigation.onCommitted.removeListener(webNavListener);
        chrome.webNavigation.onErrorOccurred.removeListener(webNavListener);
        webNavListener = null;
      }
    };

    const captureLocalhostUrl = (url) => {
      if (resolved) return;
      resolved = true;
      cleanupListeners();
      clearTimeout(timeout);
      setState({ localhostUrl: url }).then(() => {
        addLog(`Step 8: Captured localhost URL: ${url}`, 'ok');
        setStepStatus(8, 'completed');
        notifyStepComplete(8, { localhostUrl: url });
        broadcastDataUpdate({ localhostUrl: url });
        resolve();
      });
    };

    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error('Localhost redirect not captured after 120s. Step 8 click may have been blocked.'));
    }, 120000);

    webNavListener = (details) => {
      if (details.frameId === 0 && isLocalhostUrl(details.url)) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        captureLocalhostUrl(details.url);
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);
    chrome.webNavigation.onCommitted.addListener(webNavListener);
    chrome.webNavigation.onErrorOccurred.addListener(webNavListener);

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We locate the button in-page, then click it through
    // the debugger Input API directly.
    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 8: Switched to auth page. Preparing debugger click...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('Step 8: Auth tab reopened. Preparing debugger click...');
        }

        const clickResult = await sendToContentScript('signup-page', {
          type: 'STEP8_FIND_AND_CLICK',
          source: 'background',
          payload: {},
        });

        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        if (!resolved) {
          await clickWithDebugger(signupTabId, clickResult?.rect);
          await addLog('Step 8: Debugger click dispatched, waiting for redirect...');

          // Fallback: poll tab URL in case webNavigation listeners missed the redirect
          for (let i = 0; i < 30 && !resolved; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const tab = await chrome.tabs.get(signupTabId);
              if (isLocalhostUrl(tab.url)) {
                captureLocalhostUrl(tab.url);
                break;
              }
            } catch { break; }
          }
        }
      } catch (err) {
        clearTimeout(timeout);
        cleanupListeners();
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

async function executeStep9(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }
  if (!state.vpsUrl) {
    throw new Error('VPS URL not set. Please enter VPS URL in the side panel.');
  }

  await addLog('Step 9: Opening VPS panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab in the automation window
    const wid = await ensureAutomationWindowId();
    const tab = await chrome.tabs.create({ url: state.vpsUrl, active: true, windowId: wid });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog(`Step 9: Filling callback URL...`);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: {
      localhostUrl: state.localhostUrl,
      vpsType: normalizeVpsType(state.vpsType),
    },
  });
  if (response?.error) {
    throw new Error(response.error);
  }
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
