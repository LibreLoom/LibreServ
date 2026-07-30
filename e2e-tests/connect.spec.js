const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const SCREENSHOT_DIR = __dirname;
const ADMIN_PASSWORD = 'Admin12345678!';
const CONNECT_KEY = 'TEST-KEY-ABCD-EFGH';

// ---------------------------------------------------------------------------
// TOTP helpers (RFC 6238 / SHA-1 / 6-digit)
// ---------------------------------------------------------------------------

function base32Decode(encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of encoded.toUpperCase()) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret, timeOffset) {
  if (timeOffset === void 0) timeOffset = 0;
  const time = Math.floor(Date.now() / 1000) + timeOffset;
  const counter = Math.floor(time / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(counter));
  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(buffer);
  const digest = hmac.digest();
  const offset = digest[digest.length - 1] & 0xf;
  var code = ((digest[offset] & 0x7f) << 24 |
          (digest[offset + 1] & 0xff) << 16 |
          (digest[offset + 2] & 0xff) << 8 |
          (digest[offset + 3] & 0xff));
  return code.toString().padStart(6, '0').slice(-6);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureSetup(page) {
  var statusResponse = await page.request.get(BASE_URL + '/api/v1/setup/status');
  var status = await statusResponse.json();
  if (status.setup_state && status.setup_state.status === 'pending') {
    var setupHeaders = {};
    var token = process.env.E2E_SETUP_TOKEN;
    if (token) {
      setupHeaders['X-Setup-Token'] = token;
    }
    var setupResponse = await page.request.post(BASE_URL + '/api/v1/setup/complete', {
      headers: setupHeaders,
      data: {
        admin_username: 'admin',
        admin_password: ADMIN_PASSWORD,
        admin_email: 'admin@example.com'
      }
    });
    expect(setupResponse.ok()).toBeTruthy();
  } else if (status.setup_state && status.setup_state.status === 'in_progress') {
    for (var i = 0; i < 10; i++) {
      await new Promise(function(r) { setTimeout(r, 500); });
      var checkResponse = await page.request.get(BASE_URL + '/api/v1/setup/status');
      var checkStatus = await checkResponse.json();
      if ((checkStatus.setup_state && checkStatus.setup_state.status === 'complete') ||
          (checkStatus.user_status && checkStatus.user_status.setup_complete)) {
        break;
      }
    }
  }
}

function clearMFA() {
  execSync("python3 << 'PYEOF'\nimport sqlite3, bcrypt\nconn = sqlite3.connect('/var/home/plainskill/Projects/LibreServ/server/backend/dev/data/libreserv.db')\nhashed = bcrypt.hashpw(b'" + ADMIN_PASSWORD + "', bcrypt.gensalt(12)).decode()\nconn.execute('UPDATE users SET password_hash=?', (hashed,))\nconn.execute('UPDATE users SET mfa_required=0')\ntables = [r[0] for r in conn.execute('SELECT name FROM sqlite_master WHERE type=?', ('table',)).fetchall()]\nif 'mfa_methods' in tables:\n    conn.execute('DELETE FROM mfa_methods')\nconn.commit()\nconn.close()\nprint('Password reset, MFA cleared')\nPYEOF\n", { stdio: 'inherit' });
}

async function apiFetch(page, method, url, body, extraHeaders) {
  if (extraHeaders === void 0) extraHeaders = {};
  return page.evaluate(async function(params) {
    var method = params.method, url = params.url, body = params.body, extraHeaders = params.extraHeaders;
    var resp = await fetch(url, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders),
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    return {
      status: resp.status,
      ok: resp.ok,
      body: await resp.text(),
    };
  }, { method: method, url: url, body: body, extraHeaders: extraHeaders });
}

function parseBody(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

async function login(page) {
  console.log('\n=== Step 1: Login ===');
  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
  var result = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/login', {
    username: 'admin',
    password: ADMIN_PASSWORD,
  });
  var body = parseBody(result.body);
  console.log('Login status:', result.status);
  if (body.status === 'mfa_required') {
    console.log('MFA required - clearing and retrying...');
    clearMFA();
    var retry = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/login', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });
    var retryBody = parseBody(retry.body);
    console.log('Re-login status:', retryBody.username || retryBody.status);
    return retryBody;
  }
  console.log('Login username:', body.username);
  var cookies = await page.context().cookies();
  console.log('Context cookies:', cookies.map(function(c) { return c.name; }).join(', '));
  expect(cookies.length).toBeGreaterThan(0);
  return body;
}

async function enrollMFA(page) {
  console.log('\n=== Step 2: Enroll MFA ===');
  var csrfResult = await apiFetch(page, 'GET', BASE_URL + '/api/v1/auth/csrf', null);
  var csrfToken = parseBody(csrfResult.body).csrf_token;
  var setupResult = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/mfa/totp/setup', null, {
    'X-CSRF-Token': csrfToken,
  });
  expect(setupResult.status).toBe(200);
  var setupBody = parseBody(setupResult.body);
  var secret = setupBody.secret;
  console.log('TOTP secret obtained');
  var code = generateTOTP(secret);
  console.log('TOTP code:', code);
  var verifyResult = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/mfa/totp/verify', {
    code: code,
  }, { 'X-CSRF-Token': csrfToken });
  expect(verifyResult.status).toBe(200);
  console.log('TOTP verified');
  var recoveryResult = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/mfa/recovery-codes', null, {
    'X-CSRF-Token': csrfToken,
  });
  expect(recoveryResult.status).toBe(200);
  console.log('Recovery codes generated');
  await new Promise(function(r) { setTimeout(r, 500); });
  var meResult = await apiFetch(page, 'GET', BASE_URL + '/api/v1/auth/me');
  var me = parseBody(meResult.body);
  console.log('mfa_enabled:', me.mfa_enabled);
}

async function csrfRequest(page, method, url, data) {
  var csrfResult = await apiFetch(page, 'GET', BASE_URL + '/api/v1/auth/csrf', null);
  var csrfToken = parseBody(csrfResult.body).csrf_token;
  var result = await apiFetch(page, method, url, data, {
    'X-CSRF-Token': csrfToken,
  });
  return { status: result.status, ok: result.ok, body: parseBody(result.body) };
}

// Fill Connect key in the modal, then click the Connect button
// Uses page.fill() and button.click() — no evaluate hacks
async function fillConnectKeyAndActivate(page) {
  console.log('Waiting for Connect modal to appear...');

  // Wait for the modal content to exist in the DOM
  await page.waitForFunction(function() {
    var text = document.body.textContent || '';
    return text.indexOf('Enter Your Connect Key') !== -1 || text.indexOf('Paste your Connect key') !== -1;
  }, { timeout: 5000 });
  console.log('Modal detected in DOM');

  // The ModalCard renders via createPortal into document.body with:
  //   [data-slot="dialog-overlay"] (the overlay)
  //   [data-slot="dialog-content"] [role="dialog"] (the actual dialog)
  // Playwright can interact through the overlay with force:true or by waiting
  // for the content to be in the DOM. We target elements inside [role="dialog"].

  // Fill the key input inside the dialog
  var keyInput = page.locator('[role="dialog"] input[type="text"]');
  console.log('Key input count:', await keyInput.count());
  await keyInput.fill(CONNECT_KEY);
  console.log('Filled key input');

  // Click the Connect button inside the dialog
  // Use exact text match to avoid matching the "connect.serv.libreloom.org" link
  var modalBtn = page.locator('[role="dialog"]').getByText('Connect', { exact: true });
  console.log('Modal Connect button count:', await modalBtn.count());
  await modalBtn.click();
  console.log('Clicked Connect button');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Connect Integration', function() {
  test('full connect activation lifecycle', async function({ page }) {
    await login(page);
    await ensureSetup(page);
    await enrollMFA(page);

    console.log('\n=== Step 1: API connect flow ===');
    var statusBefore = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
    console.log('Connect status (before):', JSON.stringify(statusBefore.body).slice(0, 300));

    console.log('Activating connect via API...');
    var activateResp = await csrfRequest(page, 'PUT', BASE_URL + '/api/v1/connect/activate', {
      connect_key: CONNECT_KEY,
    });
    console.log('Activate status:', activateResp.status);
    expect(activateResp.ok).toBeTruthy();

    console.log('Polling for provisioning...');
    for (var pi = 0; pi < 30; pi++) {
      await new Promise(function(r) { setTimeout(r, 1000); });
      var check = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
      var services = check.body.services || {};
      var states = Object.values(services).map(function(s) { return s ? s.state : null; }).join(', ');
      var allConnected = Object.values(services).every(function(s) { return s && s.state === 'connected'; });
      if (allConnected) {
        console.log('All connected after ' + (pi + 1) + 's');
        break;
      }
      if (pi % 5 === 0) console.log('  Poll ' + (pi + 1) + 's: ' + states);
    }

    var statusAfterActivate = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
    console.log('Connect status (after activate):', JSON.stringify(statusAfterActivate.body).slice(0, 300));

    console.log('Deactivating...');
    var deactivateResp = await csrfRequest(page, 'POST', BASE_URL + '/api/v1/connect/deactivate', {});
    expect(deactivateResp.ok).toBeTruthy();

    var statusAfterDeactivate = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
    console.log('Connect status (after deactivate):', JSON.stringify(statusAfterDeactivate.body).slice(0, 300));

    console.log('\n=== Step 2: Navigate to settings ===');
    await page.goto(BASE_URL + '/settings#external_services', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await new Promise(function(r) { setTimeout(r, 1500); });
    console.log('URL:', page.url());

    console.log('\n=== Step 3: Verify External Services category ===');
    var category = page.locator('[data-slot="external-services-category"]');
    await expect(category).toBeVisible({ timeout: 10000 });
    console.log('External Services category visible');

    console.log('\n=== Step 4: Add Connect ===');
    var addConnectBtn = page.locator('button:has-text("Add Connect")');
    await expect(addConnectBtn).toBeVisible({ timeout: 5000 });
    await addConnectBtn.click();
    console.log('Clicked "Add Connect"');

    await fillConnectKeyAndActivate(page);

    // ---------------------------------------------------------------------------
    // CRITICAL: The activate endpoint takes ~20s (provisioning services).
    // The modal stays open during this time. After it closes, we should see "Connected".
    // ---------------------------------------------------------------------------
    console.log('\n=== Step 5: Wait for provisioning + modal to close ===');
    console.log('Waiting up to 45s for modal to close and card to show Connected...');

    // Try to wait for the Connected state on the connect-status-card
    // If it times out, capture the modal's error Alert text
    try {
      // Wait for the card to show "Connected" — this also waits for the modal to close
      // since the card and modal are siblings (modal renders in portal to body)
      // Timeout 45s gives time for ~20s provisioning + extra margin
      await page.locator('[data-slot="connect-status-card"]').getByText('Connected', { exact: false }).waitFor({ state: 'attached', timeout: 45000 });
      console.log('"Connected" appeared — modal closed');
    } catch (err) {
      // Timeout: aggressively inspect the modal state
      console.log('Timeout waiting for Connected — inspecting modal...');
      // Check for any error/alert text
      var errorAlert = page.locator('[role="alert"], .text-error, [class*="error"], [class*="Alert"]');
      if ((await errorAlert.count()) > 0) {
        var errorText = await errorAlert.first().innerText();
        console.log('MODAL ERROR:', errorText);
      }
      // Get the full ARIA snapshot of the dialog
      var ariaSnapshot = await page.locator('[role="dialog"]').ariaSnapshot().catch(function() { return 'No dialog'; });
      console.log('MODAL ARIA SNAPSHOT:\n' + ariaSnapshot);
      // Also get all button texts in the modal
      var btnTexts = await page.locator('[role="dialog"] button').allTextContents();
      console.log('Modal buttons:', JSON.stringify(btnTexts));
      // Screenshot for visual debug
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'connect-error-debug.png'), fullPage: true });
      console.log('Screenshot saved: connect-error-debug.png');
      throw err;
    }

    // Verify Connected state is visible
    var connectedText = page.locator('text=Connected').first();
    await expect(connectedText).toBeVisible({ timeout: 10000 });
    console.log('"Connected" text verified visible');

    var planBadge = page.locator('text=Connect One');
    await expect(planBadge).toBeVisible({ timeout: 5000 });
    console.log('Plan badge "Connect One" visible');

    console.log('\n=== Step 6: Screenshot activated ===');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'connect-activated.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: connect-activated.png');

    console.log('\n=== Step 7: Disconnect ===');
    var disconnectBtn = page.locator('button:has-text("Disconnect")').first();
    await expect(disconnectBtn).toBeVisible({ timeout: 5000 });
    await disconnectBtn.click();
    console.log('Clicked "Disconnect"');

    console.log('\n=== Step 8: Wait for Add Connect ===');
    await expect(addConnectBtn).toBeVisible({ timeout: 10000 });
    console.log('"Add Connect" reappeared');

    console.log('\n=== Step 9: Screenshot deactivated ===');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'connect-deactivated.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: connect-deactivated.png');

    console.log('\n=== All steps passed ===');
  });
});
