// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message.type === 'EXECUTE_STEP'
    || message.type === 'FILL_CODE'
    || message.type === 'STEP8_FIND_AND_CLICK'
    || message.type === 'CLICK_RESEND_EMAIL'
    || message.type === 'CHECK_ADD_PHONE_PAGE'
    || message.type === 'PHONE_SEND_CODE'
    || message.type === 'PHONE_FILL_CODE'
  ) {
    resetStopState();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step || 8}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.type === 'STEP8_FIND_AND_CLICK') {
        log(`Step 8: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      // Some step-5 sub-commands (phone send/fill) are expected to fail transiently
      // while background retries providers/numbers. Do not emit STEP_ERROR for them,
      // otherwise step waiter is rejected even if a later retry succeeds.
      if (message.payload?.suppressStepError) {
        sendResponse({ error: err.message });
        return;
      }

      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_login(message.payload);
        case 8: return await step8_findAndClick();
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'CLICK_RESEND_EMAIL':
      return await clickResendEmail(message.step);
    case 'STEP8_FIND_AND_CLICK':
      return await step8_findAndClick();
    case 'CHECK_ADD_PHONE_PAGE':
      return { isAddPhonePage: isAddPhonePageReady() };
    case 'PHONE_SEND_CODE':
      return await sendPhoneVerificationCode(message.payload);
    case 'PHONE_FILL_CODE':
      return await fillPhoneVerificationCode(message.payload);
  }
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  await humanPause(450, 1200);
  reportComplete(2);
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  log(`Step 3: Filling email: ${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 3: Email filled');

  // Check if password field is on the same page
  let passwordInput = document.querySelector('input[type="password"]');

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      await humanPause(400, 1100);
      simulateClick(submitBtn);
      log('Step 3: Submitted email, waiting for password field...');
      await sleep(2000);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('Could not find password input after submitting email. URL: ' + location.href);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 3 requires a generated password.');
  await humanPause(600, 1500);
  fillInput(passwordInput, payload.password);
  log('Step 3: Password filled');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  reportComplete(3, { email });

  // Submit the form (page will navigate away after this)
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(500, 1300);
    simulateClick(submitBtn);
    log('Step 3: Form submitted');
  }
}

// ============================================================
// Click "重新发送电子邮件" (used before step 4 and step 7 polling)
// ============================================================

async function clickResendEmail(step) {
  log(`Step ${step}: Looking for "重新发送电子邮件" button...`);

  let resendBtn = null;
  try {
    resendBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"], span',
      /重新发送电子邮件|resend\s*email/i,
      10000
    );
  } catch {
    log(`Step ${step}: "重新发送电子邮件" button not found, skipping`, 'warn');
    return;
  }

  // Prevent parent form POST submission (Remix/React Router route without action)
  const parentForm = resendBtn.closest('form');
  const blockSubmit = (e) => e.preventDefault();
  if (parentForm) parentForm.addEventListener('submit', blockSubmit, { once: true });

  await humanPause(400, 1000);
  resendBtn.click();
  log(`Step ${step}: Clicked "重新发送电子邮件"`, 'ok');
  await sleep(2000);

  if (parentForm) parentForm.removeEventListener('submit', blockSubmit);
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      await sleep(1000);
      reportComplete(step);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`Step ${step}: Code filled`);

  // Report complete BEFORE submit (page may navigate away)
  reportComplete(step);

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('No email provided for login.');

  log(`Step 6: Logging in with ${email}...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 6: Email filled');

  // Submit email
  await sleep(500);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    await humanPause(400, 1100);
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  const passwordInput = await waitForLoginPasswordField();
  if (passwordInput) {
    log('Step 6: Password field found, filling password...');
    await humanPause(550, 1450);
    fillInput(passwordInput, password);

    await sleep(500);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    // Report complete BEFORE submit in case page navigates
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      await humanPause(450, 1200);
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }
    return;
  }

  // No password field — OTP flow
  log('Step 6: No password field. OTP flow or auto-redirect.');
  reportComplete(6, { needsOTP: true });
}

async function waitForLoginPasswordField(timeout = 25000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const passwordInput = findVisiblePasswordInput();
    if (passwordInput) {
      return passwordInput;
    }

    await sleep(250);
  }

  log(`Step 6: Password field did not appear within ${Math.round(timeout / 1000)}s.`, 'warn');
  return null;
}

function findVisiblePasswordInput() {
  const inputs = document.querySelectorAll('input[type="password"]');
  for (const input of inputs) {
    if (isElementVisible(input)) {
      return input;
    }
  }
  return null;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// ============================================================
// Step 8: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  log('Step 8: Looking for OAuth consent "继续" button...');

  const continueBtn = await findContinueButton();
  await waitForButtonEnabled(continueBtn);

  await humanPause(350, 900);
  continueBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  continueBtn.focus();
  await sleep(250);

  const rect = getSerializableRect(continueBtn);
  log('Step 8: Found "继续" button and prepared debugger click coordinates.');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

async function findContinueButton() {
  try {
    return await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    try {
      return await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
    }
  }
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('"继续" button stayed disabled for too long. URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('"继续" button has no clickable size after scrolling. URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

const ADD_PHONE_PAGE_PATTERN = /add[\s-]*phone|phone\s*number|telephone|手机号|手机号码|添加手机号/i;
const PHONE_VERIFICATION_PAGE_PATTERN = /phone[\s-]*verification|verify\s*(?:your\s*)?phone|sms\s*code|verification\s*code|验证码|短信验证码/i;
const STEP5_SUBMIT_ERROR_PATTERN = /unable\s+to\s+create\s+(?:your\s+)?account|couldn'?t\s+create\s+(?:your\s+)?account|something\s+went\s+wrong|invalid\s+(?:birthday|birth|date)|生日|出生日期|请重试/i;
const PHONE_VERIFICATION_ERROR_PATTERN = /invalid|incorrect|try\s+again|error|failed|验证码|不正确|错误|失败/i;
const OAUTH_CONSENT_PATTERN = /login\s+to\s+codex|log\s+in\s+to\s+codex|使用\s*chatgpt\s*登录到\s*codex|authorize|授权/i;

function getPageTextSnapshot() {
  return (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAddPhonePageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  if (/\/add-phone(?:[/?#]|$)/i.test(path)) return true;

  const phoneInput = document.querySelector(
    'input[type="tel"]:not([maxlength="6"]), input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]'
  );
  if (phoneInput && isElementVisible(phoneInput)) {
    return true;
  }

  return ADD_PHONE_PAGE_PATTERN.test(getPageTextSnapshot());
}

function isPhoneVerificationPageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  if (/\/phone-verification(?:[/?#]|$)/i.test(path)) return true;

  const fields = findPhoneCodeInputs();
  if (fields.singleInput || fields.splitInputs.length >= 6) {
    return true;
  }

  return PHONE_VERIFICATION_PAGE_PATTERN.test(getPageTextSnapshot());
}

function isOAuthConsentPageReady() {
  const continueBtn = document.querySelector(
    'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107'
  );
  if (!continueBtn || !isElementVisible(continueBtn)) return false;
  return OAUTH_CONSENT_PATTERN.test(getPageTextSnapshot());
}

function getStep5SubmitErrorText() {
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[id$="-errors"]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (!isElementVisible(node)) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && STEP5_SUBMIT_ERROR_PATTERN.test(text)) {
        return text;
      }
    }
  }

  const pageText = getPageTextSnapshot();
  if (STEP5_SUBMIT_ERROR_PATTERN.test(pageText)) {
    return pageText.slice(0, 240);
  }

  return '';
}

async function waitForStep5SubmitOutcome(timeout = 18000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const errorText = getStep5SubmitErrorText();
    if (errorText) {
      return { invalidProfile: true, errorText };
    }

    if (isAddPhonePageReady()) {
      return { success: true, addPhonePage: true };
    }

    if (isOAuthConsentPageReady()) {
      return { success: true, addPhonePage: false };
    }

    await sleep(200);
  }

  const errorText = getStep5SubmitErrorText();
  if (errorText) {
    return { invalidProfile: true, errorText };
  }

  if (isAddPhonePageReady()) {
    return { success: true, addPhonePage: true };
  }

  return { success: true, addPhonePage: false, assumed: true };
}

function getActionText(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function findActionButton(pattern, { allowDisabled = false } = {}) {
  const candidates = document.querySelectorAll('button, [role="button"], input[type="submit"]');
  for (const el of candidates) {
    if (!isElementVisible(el)) continue;
    if (!allowDisabled && !isButtonEnabled(el)) continue;
    if (pattern.test(getActionText(el))) {
      return el;
    }
  }
  return null;
}

function findPhoneInputField() {
  const selectors = [
    'input[type="tel"]',
    'input[name*="phone" i]',
    'input[id*="phone" i]',
    'input[autocomplete="tel"]',
  ];
  for (const selector of selectors) {
    const input = document.querySelector(selector);
    if (input && isElementVisible(input)) {
      return input;
    }
  }
  return null;
}

function findPhoneCodeInputs() {
  const single = document.querySelector(
    'input[name="code"], input[name="otp"], input[inputmode="numeric"][maxlength="6"], input[maxlength="6"]'
  );
  if (single && isElementVisible(single)) {
    return { singleInput: single, splitInputs: [] };
  }

  const splitInputs = Array.from(document.querySelectorAll('input[maxlength="1"]'))
    .filter((el) => isElementVisible(el));
  if (splitInputs.length >= 6) {
    return { singleInput: null, splitInputs };
  }

  return { singleInput: null, splitInputs: [] };
}

function getPhoneVerificationErrorText() {
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (!isElementVisible(node)) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && PHONE_VERIFICATION_ERROR_PATTERN.test(text)) {
        return text;
      }
    }
  }
  return '';
}

async function waitForPhoneCodeInput(timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    const fields = findPhoneCodeInputs();
    if (fields.singleInput || fields.splitInputs.length >= 6) {
      return true;
    }
    const err = getPhoneVerificationErrorText();
    if (err) {
      throw new Error(err);
    }
    await sleep(200);
  }
  return false;
}

async function waitForPhoneVerificationOutcome(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();

    if (!isAddPhonePageReady() && !isPhoneVerificationPageReady()) {
      return { verified: true };
    }

    const errorText = getPhoneVerificationErrorText();
    if (errorText) {
      return { verified: false, invalidCode: true, error: errorText };
    }

    await sleep(250);
  }

  if (!isAddPhonePageReady() && !isPhoneVerificationPageReady()) {
    return { verified: true };
  }

  return { verified: false, error: 'Phone verification did not finish in time.' };
}

async function sendPhoneVerificationCode(payload = {}) {
  const phoneNumber = String(payload.phoneNumber || '').trim();
  if (!phoneNumber) {
    throw new Error('No phone number provided.');
  }
  if (!isAddPhonePageReady()) {
    throw new Error('Current page is not add-phone.');
  }

  let phoneInput = findPhoneInputField();
  if (!phoneInput) {
    phoneInput = await waitForElement(
      'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]',
      12000
    );
  }

  await humanPause(350, 900);
  fillInput(phoneInput, phoneNumber);
  log(`Step 5: Filled phone number ${phoneNumber}`);

  await sleep(300);

  let sendBtn = findActionButton(/send|continue|next|code|验证码|短信|发送|继续/i);
  if (!sendBtn) {
    sendBtn = document.querySelector('button[type="submit"], input[type="submit"]');
  }
  if (!sendBtn || !isElementVisible(sendBtn)) {
    throw new Error('Could not find send-code button on add-phone page.');
  }

  await humanPause(300, 800);
  simulateClick(sendBtn);
  log('Step 5: Triggered phone SMS send');

  const codeInputReady = await waitForPhoneCodeInput(20000);
  if (!codeInputReady) {
    throw new Error('Phone OTP input did not appear after sending SMS code.');
  }
  return { codeInputReady, isAddPhonePage: isAddPhonePageReady() };
}

async function fillPhoneVerificationCode(payload = {}) {
  const rawCode = String(payload.code || '').trim();
  const codeMatch = rawCode.match(/\d{6}/);
  if (!codeMatch) {
    throw new Error('Phone verification code is empty or invalid.');
  }
  const code = codeMatch[0];

  if (!isAddPhonePageReady() && !isPhoneVerificationPageReady()) {
    return {
      verified: false,
      codeFilled: false,
      error: 'Not on phone-verification page when trying to fill OTP.',
    };
  }

  const fields = findPhoneCodeInputs();
  if (!fields.singleInput && fields.splitInputs.length < 6) {
    await waitForPhoneCodeInput(12000);
  }

  const resolved = findPhoneCodeInputs();
  if (resolved.singleInput) {
    fillInput(resolved.singleInput, code);
  } else if (resolved.splitInputs.length >= 6) {
    for (let i = 0; i < 6; i++) {
      fillInput(resolved.splitInputs[i], code[i]);
      await sleep(80);
    }
  } else {
    throw new Error('Could not find phone OTP input.');
  }
  log(`Step 5: Filled phone OTP code ${code}`);

  await sleep(300);
  const verifyBtn = findActionButton(/verify|confirm|submit|continue|完成|确认|验证|继续/i)
    || document.querySelector('button[type="submit"], input[type="submit"]');

  if (verifyBtn && isElementVisible(verifyBtn)) {
    await humanPause(300, 800);
    simulateClick(verifyBtn);
    log('Step 5: Submitted phone OTP code');
  }

  const outcome = await waitForPhoneVerificationOutcome(32000);
  return {
    ...outcome,
    codeFilled: true,
  };
}

async function step5_fillNameBirthday(payload) {
  const skipIfNoProfile = Boolean(payload?.skipIfNoProfile);
  if (isAddPhonePageReady()) {
    log('Step 5: add-phone page detected, deferring profile form fill.', 'warn');
    reportComplete(5, { addPhonePage: true, profileSkipped: true });
    return { addPhonePage: true, profileSkipped: true };
  }

  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('No birthday or age data provided.');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    if (skipIfNoProfile) {
      log('Step 5: Profile form not found after phone verification, skip deferred profile fill.', 'warn');
      reportComplete(5, { addPhonePage: false, profileSkipped: true });
      return { addPhonePage: false, profileSkipped: true };
    }
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`Step 5: Name filled: ${fullName}`);

  let birthdayMode = false;
  let ageInput = null;

  for (let i = 0; i < 100; i++) {
    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');

    // Some pages include a hidden birthday input even though the real UI is "age".
    // In that case we must prioritize filling age to satisfy required validation.
    if (ageInput) break;

    if ((yearSpinner && monthSpinner && daySpinner) || hiddenBirthday) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('Birthday field detected, but no birthday data provided.');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');

    if (yearSpinner && monthSpinner && daySpinner) {
      log('Step 5: Birthday fields detected, filling birthday...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`Step 5: Birthday filled: ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set: ${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('Age field detected, but no age data provided.');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`Step 5: Age filled: ${resolvedAge}`);

    // Some age-mode pages still submit a hidden birthday field.
    // Keep it aligned with generated data so backend validation won't reject.
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday && hasBirthdayData) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set (age mode): ${dateStr}`);
    }
  } else {
    throw new Error('Could not find birthday or age input. URL: ' + location.href);
  }

  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  if (!completeBtn) {
    throw new Error('Could not find account creation submit button. URL: ' + location.href);
  }

  await humanPause(500, 1300);
  simulateClick(completeBtn);
  log('Step 5: Clicked "完成帐户创建"');

  const outcome = await waitForStep5SubmitOutcome();
  if (outcome.invalidProfile) {
    throw new Error(outcome.errorText || 'Profile submission rejected.');
  }

  const addPhonePage = Boolean(outcome.addPhonePage);
  if (addPhonePage) {
    log('Step 5: Redirected to add-phone page', 'warn');
  } else {
    log('Step 5: Account profile accepted', 'ok');
  }

  reportComplete(5, { addPhonePage });
  return { addPhonePage };
}
