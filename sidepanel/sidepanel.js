// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  failed: '\u2717',     // ✗
  stopped: '\u25A0',    // ■
};

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const btnFetchEmail = document.getElementById('btn-fetch-email');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const stepsProgress = document.getElementById('steps-progress');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const autoContinueBar = document.getElementById('auto-continue-bar');
const btnClearLog = document.getElementById('btn-clear-log');
const inputVpsUrl = document.getElementById('input-vps-url');
const selectVpsType = document.getElementById('select-vps-type');
const selectMailProvider = document.getElementById('select-mail-provider');
const selectSmsProvider = document.getElementById('select-sms-provider');
const rowInbucketHost = document.getElementById('row-inbucket-host');
const inputInbucketHost = document.getElementById('input-inbucket-host');
const rowInbucketMailbox = document.getElementById('row-inbucket-mailbox');
const inputInbucketMailbox = document.getElementById('input-inbucket-mailbox');
const rowFreemailApiUrl = document.getElementById('row-freemail-api-url');
const inputFreemailApiUrl = document.getElementById('input-freemail-api-url');
const rowFreemailJwtToken = document.getElementById('row-freemail-jwt-token');
const inputFreemailJwtToken = document.getElementById('input-freemail-jwt-token');
const rowFreemailDomain = document.getElementById('row-freemail-domain');
const inputFreemailDomain = document.getElementById('input-freemail-domain');
const rowSmsbowerKey = document.getElementById('row-smsbower-key');
const inputSmsbowerKey = document.getElementById('input-smsbower-key');
const rowSmsbowerBaseUrl = document.getElementById('row-smsbower-base-url');
const inputSmsbowerBaseUrl = document.getElementById('input-smsbower-base-url');
const rowSmsbowerService = document.getElementById('row-smsbower-service');
const inputSmsbowerService = document.getElementById('input-smsbower-service');
const rowSmsbowerCountry = document.getElementById('row-smsbower-country');
const inputSmsbowerCountry = document.getElementById('input-smsbower-country');
const rowSmsbowerMaxPrice = document.getElementById('row-smsbower-max-price');
const inputSmsbowerMaxPrice = document.getElementById('input-smsbower-max-price');
const rowSmsbowerMaxTries = document.getElementById('row-smsbower-max-tries');
const inputSmsbowerMaxTries = document.getElementById('input-smsbower-max-tries');
const rowSmsbowerTimeout = document.getElementById('row-smsbower-timeout');
const inputSmsbowerTimeout = document.getElementById('input-smsbower-timeout');
const rowHeroKey = document.getElementById('row-hero-key');
const inputHeroKey = document.getElementById('input-hero-key');
const rowHeroBaseUrl = document.getElementById('row-hero-base-url');
const inputHeroBaseUrl = document.getElementById('input-hero-base-url');
const rowHeroService = document.getElementById('row-hero-service');
const inputHeroService = document.getElementById('input-hero-service');
const rowHeroCountry = document.getElementById('row-hero-country');
const inputHeroCountry = document.getElementById('input-hero-country');
const rowHeroMaxPrice = document.getElementById('row-hero-max-price');
const inputHeroMaxPrice = document.getElementById('input-hero-max-price');
const rowHeroMaxTries = document.getElementById('row-hero-max-tries');
const inputHeroMaxTries = document.getElementById('input-hero-max-tries');
const rowHeroTimeout = document.getElementById('row-hero-timeout');
const inputHeroTimeout = document.getElementById('input-hero-timeout');
const rowFivesimKey = document.getElementById('row-fivesim-key');
const inputFivesimKey = document.getElementById('input-fivesim-key');
const rowFivesimService = document.getElementById('row-fivesim-service');
const inputFivesimService = document.getElementById('input-fivesim-service');
const rowFivesimCountry = document.getElementById('row-fivesim-country');
const inputFivesimCountry = document.getElementById('input-fivesim-country');
const rowFivesimMaxPrice = document.getElementById('row-fivesim-max-price');
const inputFivesimMaxPrice = document.getElementById('input-fivesim-max-price');
const rowFivesimMaxTries = document.getElementById('row-fivesim-max-tries');
const inputFivesimMaxTries = document.getElementById('input-fivesim-max-tries');
const rowFivesimTimeout = document.getElementById('row-fivesim-timeout');
const inputFivesimTimeout = document.getElementById('input-fivesim-timeout');
const inputRunCount = document.getElementById('input-run-count');
const DEFAULT_VPS_URL = 'https://ddv.667410.xyz/manage/auth-files';
const DEFAULT_VPS_TYPE = 'codeProxy';
const DEFAULT_MAIL_PROVIDER = 'freemail';
const DEFAULT_SMS_PROVIDER = 'fivesim';
const DEFAULT_FREEMAIL_API_URL = 'https://mailfree.zhangbaba520.workers.dev/';
const DEFAULT_FREEMAIL_DOMAIN = 'mail4.667410.xyz,mail5.667410.xyz,mail6.667410.xyz,mail7.667410.xyz,mail8.667410.xyz,mail9.667410.xyz,mail10.667410.xyz,mail11.667410.xyz,mail12.667410.xyz,baidu.667410.xyz,163.667410.xyz,gmail.667410.xyz,qq.667410.xyz,openai.667410.xyz,runtime.667410.xyz,edu.667410.xyz,google.667410.xyz,apple.667410.xyz,codex.667410.xyz';
const DEFAULT_SMSBOWER_MAX_PRICE = 0.08;
const DEFAULT_HERO_MAX_PRICE = 0.08;
const DEFAULT_FIVESIM_MAX_PRICE = 50;

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = 'error', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove());
}

// ============================================================
// State Restore on load
// ============================================================

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });

    if (state.oauthUrl) {
      displayOauthUrl.textContent = state.oauthUrl;
      displayOauthUrl.classList.add('has-value');
    }
    if (state.localhostUrl) {
      displayLocalhostUrl.textContent = state.localhostUrl;
      displayLocalhostUrl.classList.add('has-value');
    }
    if (state.email) {
      inputEmail.value = state.email;
    }
    syncPasswordField(state);
    inputVpsUrl.value = state.vpsUrl || DEFAULT_VPS_URL;
    selectVpsType.value = state.vpsType || DEFAULT_VPS_TYPE;
    selectMailProvider.value = state.mailProvider || DEFAULT_MAIL_PROVIDER;
    selectSmsProvider.value = state.smsProvider || DEFAULT_SMS_PROVIDER;
    if (state.inbucketHost) {
      inputInbucketHost.value = state.inbucketHost;
    }
    if (state.inbucketMailbox) {
      inputInbucketMailbox.value = state.inbucketMailbox;
    }
    if (state.freemailApiUrl) {
      inputFreemailApiUrl.value = state.freemailApiUrl;
    } else {
      inputFreemailApiUrl.value = DEFAULT_FREEMAIL_API_URL;
    }
    if (state.freemailJwtToken) {
      inputFreemailJwtToken.value = state.freemailJwtToken;
    }
    if (state.freemailDomain) {
      inputFreemailDomain.value = state.freemailDomain;
    } else {
      inputFreemailDomain.value = DEFAULT_FREEMAIL_DOMAIN;
    }
    if (state.smsbowerApiKey) inputSmsbowerKey.value = state.smsbowerApiKey;
    if (state.smsbowerBaseUrl) inputSmsbowerBaseUrl.value = state.smsbowerBaseUrl;
    if (state.smsbowerService) inputSmsbowerService.value = state.smsbowerService;
    if (state.smsbowerCountry !== undefined) inputSmsbowerCountry.value = state.smsbowerCountry;
    if (state.smsbowerMaxPrice !== undefined) {
      inputSmsbowerMaxPrice.value = state.smsbowerMaxPrice;
    } else {
      inputSmsbowerMaxPrice.value = DEFAULT_SMSBOWER_MAX_PRICE;
    }
    if (state.smsbowerMaxTries !== undefined) inputSmsbowerMaxTries.value = state.smsbowerMaxTries;
    if (state.smsbowerPollTimeoutSec !== undefined) inputSmsbowerTimeout.value = state.smsbowerPollTimeoutSec;
    if (state.heroApiKey) inputHeroKey.value = state.heroApiKey;
    if (state.heroBaseUrl) inputHeroBaseUrl.value = state.heroBaseUrl;
    if (state.heroService) inputHeroService.value = state.heroService;
    if (state.heroCountry !== undefined) inputHeroCountry.value = state.heroCountry;
    if (state.heroMaxPrice !== undefined) {
      inputHeroMaxPrice.value = state.heroMaxPrice;
    } else {
      inputHeroMaxPrice.value = DEFAULT_HERO_MAX_PRICE;
    }
    if (state.heroMaxTries !== undefined) inputHeroMaxTries.value = state.heroMaxTries;
    if (state.heroPollTimeoutSec !== undefined) inputHeroTimeout.value = state.heroPollTimeoutSec;
    if (state.fivesimApiKey) inputFivesimKey.value = state.fivesimApiKey;
    if (state.fivesimService) inputFivesimService.value = state.fivesimService;
    if (state.fivesimCountry) inputFivesimCountry.value = state.fivesimCountry;
    if (state.fivesimMaxPrice !== undefined) {
      inputFivesimMaxPrice.value = state.fivesimMaxPrice;
    } else {
      inputFivesimMaxPrice.value = DEFAULT_FIVESIM_MAX_PRICE;
    }
    if (state.fivesimMaxTries !== undefined) inputFivesimMaxTries.value = state.fivesimMaxTries;
    if (state.fivesimPollTimeoutSec !== undefined) inputFivesimTimeout.value = state.fivesimPollTimeoutSec;

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logs) {
      for (const entry of state.logs) {
        appendLog(entry);
      }
    }

    updateStatusDisplay(state);
    updateProgressCounter();
    updateMailProviderUI();
    updateSmsProviderUI();
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

function syncPasswordField(state) {
  inputPassword.value = state.customPassword || state.password || '';
}

function updateMailProviderUI() {
  const useInbucket = selectMailProvider.value === 'inbucket';
  const useFreemail = selectMailProvider.value === 'freemail';
  rowInbucketHost.style.display = useInbucket ? '' : 'none';
  rowInbucketMailbox.style.display = useInbucket ? '' : 'none';
  rowFreemailApiUrl.style.display = useFreemail ? '' : 'none';
  rowFreemailJwtToken.style.display = useFreemail ? '' : 'none';
  rowFreemailDomain.style.display = useFreemail ? '' : 'none';
}

function updateSmsProviderUI() {
  const provider = selectSmsProvider.value || DEFAULT_SMS_PROVIDER;
  const showSmsbower = provider === 'smsbower' || provider === 'auto';
  const showHero = provider === 'hero' || provider === 'auto';
  const showFivesim = provider === 'fivesim' || provider === 'auto';

  rowSmsbowerKey.style.display = showSmsbower ? '' : 'none';
  rowSmsbowerBaseUrl.style.display = showSmsbower ? '' : 'none';
  rowSmsbowerService.style.display = showSmsbower ? '' : 'none';
  rowSmsbowerCountry.style.display = showSmsbower ? '' : 'none';
  rowSmsbowerMaxPrice.style.display = showSmsbower ? '' : 'none';
  rowSmsbowerMaxTries.style.display = showSmsbower ? '' : 'none';
  rowSmsbowerTimeout.style.display = showSmsbower ? '' : 'none';

  rowHeroKey.style.display = showHero ? '' : 'none';
  rowHeroBaseUrl.style.display = showHero ? '' : 'none';
  rowHeroService.style.display = showHero ? '' : 'none';
  rowHeroCountry.style.display = showHero ? '' : 'none';
  rowHeroMaxPrice.style.display = showHero ? '' : 'none';
  rowHeroMaxTries.style.display = showHero ? '' : 'none';
  rowHeroTimeout.style.display = showHero ? '' : 'none';

  rowFivesimKey.style.display = showFivesim ? '' : 'none';
  rowFivesimService.style.display = showFivesim ? '' : 'none';
  rowFivesimCountry.style.display = showFivesim ? '' : 'none';
  rowFivesimMaxPrice.style.display = showFivesim ? '' : 'none';
  rowFivesimMaxTries.style.display = showFivesim ? '' : 'none';
  rowFivesimTimeout.style.display = showFivesim ? '' : 'none';
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }

  updateButtonStates();
  updateProgressCounter();
}

function updateProgressCounter() {
  let completed = 0;
  document.querySelectorAll('.step-row').forEach(row => {
    if (row.classList.contains('completed')) completed++;
  });
  stepsProgress.textContent = `${completed} / 9`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else if (row.classList.contains('stopped')) statuses[step] = 'stopped';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');

  for (let step = 1; step <= 9; step++) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    if (!btn) continue;

    if (anyRunning) {
      btn.disabled = true;
    } else if (step === 1) {
      btn.disabled = false;
    } else {
      const prevStatus = statuses[step - 1];
      const currentStatus = statuses[step];
      btn.disabled = !(prevStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'completed' || currentStatus === 'stopped');
    }
  }

  updateStopButtonState(anyRunning || autoContinueBar.style.display !== 'none');
}

function updateStopButtonState(active) {
  btnStop.disabled = !active;
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;

  statusBar.className = 'status-bar';

  const running = Object.entries(state.stepStatuses).find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = `Step ${running[0]} running...`;
    statusBar.classList.add('running');
    return;
  }

  const failed = Object.entries(state.stepStatuses).find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = `Step ${failed[0]} failed`;
    statusBar.classList.add('failed');
    return;
  }

  const stopped = Object.entries(state.stepStatuses).find(([, s]) => s === 'stopped');
  if (stopped) {
    displayStatus.textContent = `Step ${stopped[0]} stopped`;
    statusBar.classList.add('stopped');
    return;
  }

  const lastCompleted = Object.entries(state.stepStatuses)
    .filter(([, s]) => s === 'completed')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastCompleted === 9) {
    displayStatus.textContent = 'All steps completed!';
    statusBar.classList.add('completed');
  } else if (lastCompleted) {
    displayStatus.textContent = `Step ${lastCompleted} done`;
  } else {
    displayStatus.textContent = 'Ready';
  }
}

function appendLog(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const levelLabel = entry.level.toUpperCase();
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const stepMatch = entry.message.match(/Step (\d)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function fetchProviderEmail() {
  const defaultLabel = '自动';
  btnFetchEmail.disabled = true;
  btnFetchEmail.textContent = '...';
  const provider = selectMailProvider.value;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_PROVIDER_EMAIL',
      source: 'sidepanel',
      payload: { provider, generateNew: true },
    });

    if (response?.error) {
      throw new Error(response.error);
    }
    if (!response?.email) {
      throw new Error('未获取到邮箱地址。');
    }

    inputEmail.value = response.email;
    showToast(`已获取邮箱：${response.email}`, 'success', 2500);
    return response.email;
  } catch (err) {
    showToast(`自动获取失败：${err.message}`, 'error');
    throw err;
  } finally {
    btnFetchEmail.disabled = false;
    btnFetchEmail.textContent = defaultLabel;
  }
}

function syncPasswordToggleLabel() {
  btnTogglePassword.textContent = inputPassword.type === 'password' ? '显示' : '隐藏';
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    if (step === 3) {
      const email = inputEmail.value.trim();
      if (!email) {
        showToast('请先粘贴邮箱，或点击“自动”获取', 'warn');
        return;
      }
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step, email } });
    } else {
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
    }
  });
});

btnFetchEmail.addEventListener('click', async () => {
  await fetchProviderEmail().catch(() => {});
});

btnTogglePassword.addEventListener('click', () => {
  inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
  syncPasswordToggleLabel();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_FLOW', source: 'sidepanel', payload: {} });
  showToast('正在停止当前流程...', 'warn', 2000);
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  const totalRuns = parseInt(inputRunCount.value) || 1;
  btnAutoRun.disabled = true;
  inputRunCount.disabled = true;
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Running...';
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
});

btnAutoContinue.addEventListener('click', async () => {
  const email = inputEmail.value.trim();
  if (!email) {
    showToast('请先自动获取或手动粘贴邮箱', 'warn');
    return;
  }
  autoContinueBar.style.display = 'none';
  await chrome.runtime.sendMessage({ type: 'RESUME_AUTO_RUN', source: 'sidepanel', payload: { email } });
});

// Reset
btnReset.addEventListener('click', async () => {
  if (confirm('Reset all steps and data?')) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    displayOauthUrl.textContent = 'Waiting...';
    displayOauthUrl.classList.remove('has-value');
    displayLocalhostUrl.textContent = 'Waiting...';
    displayLocalhostUrl.classList.remove('has-value');
    inputEmail.value = '';
    displayStatus.textContent = 'Ready';
    statusBar.className = 'status-bar';
    logArea.innerHTML = '';
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    inputRunCount.disabled = false;
    btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
    autoContinueBar.style.display = 'none';
    updateStopButtonState(false);
    updateButtonStates();
    updateProgressCounter();
  }
});

// Clear log
btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

// Save settings on change
inputEmail.addEventListener('change', async () => {
  const email = inputEmail.value.trim();
  if (email) {
    await chrome.runtime.sendMessage({ type: 'SAVE_EMAIL', source: 'sidepanel', payload: { email } });
  }
});

inputVpsUrl.addEventListener('change', async () => {
  const vpsUrl = inputVpsUrl.value.trim();
  if (vpsUrl) {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTING', source: 'sidepanel', payload: { vpsUrl } });
  }
});

selectVpsType.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { vpsType: selectVpsType.value },
  });
});

inputPassword.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { customPassword: inputPassword.value },
  });
});

selectMailProvider.addEventListener('change', async () => {
  updateMailProviderUI();
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING', source: 'sidepanel',
    payload: { mailProvider: selectMailProvider.value },
  });
});

selectSmsProvider.addEventListener('change', async () => {
  updateSmsProviderUI();
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsProvider: selectSmsProvider.value },
  });
});

inputInbucketMailbox.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { inbucketMailbox: inputInbucketMailbox.value.trim() },
  });
});

inputInbucketHost.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { inbucketHost: inputInbucketHost.value.trim() },
  });
});

inputFreemailApiUrl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { freemailApiUrl: inputFreemailApiUrl.value.trim() },
  });
});

inputFreemailJwtToken.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { freemailJwtToken: inputFreemailJwtToken.value.trim() },
  });
});

inputFreemailDomain.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { freemailDomain: inputFreemailDomain.value.trim() },
  });
});

inputSmsbowerKey.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsbowerApiKey: inputSmsbowerKey.value.trim() },
  });
});

inputSmsbowerBaseUrl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsbowerBaseUrl: inputSmsbowerBaseUrl.value.trim() },
  });
});

inputSmsbowerService.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsbowerService: inputSmsbowerService.value.trim() },
  });
});

inputSmsbowerCountry.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsbowerCountry: inputSmsbowerCountry.value.trim() },
  });
});

inputSmsbowerMaxPrice.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsbowerMaxPrice: inputSmsbowerMaxPrice.value.trim() },
  });
});

inputSmsbowerMaxTries.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsbowerMaxTries: inputSmsbowerMaxTries.value.trim() },
  });
});

inputSmsbowerTimeout.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { smsbowerPollTimeoutSec: inputSmsbowerTimeout.value.trim() },
  });
});

inputHeroKey.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { heroApiKey: inputHeroKey.value.trim() },
  });
});

inputHeroBaseUrl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { heroBaseUrl: inputHeroBaseUrl.value.trim() },
  });
});

inputHeroService.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { heroService: inputHeroService.value.trim() },
  });
});

inputHeroCountry.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { heroCountry: inputHeroCountry.value.trim() },
  });
});

inputHeroMaxPrice.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { heroMaxPrice: inputHeroMaxPrice.value.trim() },
  });
});

inputHeroMaxTries.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { heroMaxTries: inputHeroMaxTries.value.trim() },
  });
});

inputHeroTimeout.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { heroPollTimeoutSec: inputHeroTimeout.value.trim() },
  });
});

inputFivesimKey.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { fivesimApiKey: inputFivesimKey.value.trim() },
  });
});

inputFivesimService.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { fivesimService: inputFivesimService.value.trim() },
  });
});

inputFivesimCountry.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { fivesimCountry: inputFivesimCountry.value.trim() },
  });
});

inputFivesimMaxPrice.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { fivesimMaxPrice: inputFivesimMaxPrice.value.trim() },
  });
});

inputFivesimMaxTries.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { fivesimMaxTries: inputFivesimMaxTries.value.trim() },
  });
});

inputFivesimTimeout.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { fivesimPollTimeoutSec: inputFivesimTimeout.value.trim() },
  });
});

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      if (message.payload.level === 'error') {
        showToast(message.payload.message, 'error');
      }
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay);
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          syncPasswordField(state);
          if (state.oauthUrl) {
            displayOauthUrl.textContent = state.oauthUrl;
            displayOauthUrl.classList.add('has-value');
          }
          if (state.localhostUrl) {
            displayLocalhostUrl.textContent = state.localhostUrl;
            displayLocalhostUrl.classList.add('has-value');
          }
        });
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      // Full UI reset for next run
      displayOauthUrl.textContent = 'Waiting...';
      displayOauthUrl.classList.remove('has-value');
      displayLocalhostUrl.textContent = 'Waiting...';
      displayLocalhostUrl.classList.remove('has-value');
      inputEmail.value = '';
      displayStatus.textContent = 'Ready';
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      updateStopButtonState(false);
      updateProgressCounter();
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.email) {
        inputEmail.value = message.payload.email;
      }
      if (message.payload.password !== undefined) {
        inputPassword.value = message.payload.password || '';
      }
      if (message.payload.oauthUrl) {
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
      }
      if (message.payload.localhostUrl) {
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
      }
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns } = message.payload;
      const runLabel = totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      switch (phase) {
        case 'waiting_email':
          autoContinueBar.style.display = 'flex';
          btnAutoRun.innerHTML = `Paused${runLabel}`;
          updateStopButtonState(true);
          break;
        case 'running':
          btnAutoRun.innerHTML = `Running${runLabel}`;
          updateStopButtonState(true);
          break;
        case 'complete':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          updateStopButtonState(false);
          break;
        case 'stopped':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          updateStopButtonState(false);
          break;
      }
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('multipage-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('multipage-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Init
// ============================================================

initTheme();
restoreState().then(() => {
  syncPasswordToggleLabel();
  updateButtonStates();
});
