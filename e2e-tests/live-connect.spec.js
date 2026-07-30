const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const SCREENSHOT_DIR = __dirname;
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin12345678!';
const CONNECT_KEY = 'UHUX-QDXA-DM9A-RHWL';

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

function parseBody(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

// Cookie-based API fetch via page.evaluate (matches existing test patterns)
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

// CSRF-aware fetch
async function csrfRequest(page, method, url, data) {
  var csrfResult = await apiFetch(page, 'GET', BASE_URL + '/api/v1/auth/csrf', null);
  var csrfToken = parseBody(csrfResult.body).csrf_token;
  var result = await apiFetch(page, method, url, data, {
    'X-CSRF-Token': csrfToken,
  });
  return { status: result.status, ok: result.ok, body: parseBody(result.body) };
}

// Login via API — handles MFA by clearing it and retrying
async function login(page) {
  console.log('\n=== Login via API ===');
  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });

  // Try direct login first (MFA may be enabled)
  var result = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/login', {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  var body = parseBody(result.body);
  console.log('Login status:', result.status, JSON.stringify(body).slice(0, 200));

  if (body.status === 'mfa_required') {
    console.log('MFA required — clearing via API and retrying...');
    // Try to enroll MFA (setup TOTP, verify current code)
    await enrollMFA(page);
    // Re-login with MFA code
    var mfaCode = generateTOTP(body.totp_secret);
    var retryResult = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/login', {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      mfa_code: mfaCode,
    });
    var retryBody = parseBody(retryResult.body);
    console.log('Re-login (with MFA) status:', retryResult.status, JSON.stringify(retryBody).slice(0, 200));
    return retryBody;
  }

  // Check cookies were set
  var cookies = await page.context().cookies();
  console.log('Context cookies:', cookies.map(function(c) { return c.name; }).join(', '));
  expect(cookies.length).toBeGreaterThan(0);
  return body;
}

// Enroll TOTP via API (setup + verify + recovery codes)
async function enrollMFA(page) {
  console.log('\n=== Enroll MFA ===');
  var csrfResult = await apiFetch(page, 'GET', BASE_URL + '/api/v1/auth/csrf', null);
  var csrfToken = parseBody(csrfResult.body).csrf_token;

  // Setup TOTP
  var setupResult = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/mfa/totp/setup', null, {
    'X-CSRF-Token': csrfToken,
  });
  expect(setupResult.status).toBe(200);
  var setupBody = parseBody(setupResult.body);
  var secret = setupBody.secret;
  console.log('TOTP secret obtained');

  // Verify with current code
  var code = generateTOTP(secret);
  console.log('TOTP code:', code);
  var verifyResult = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/mfa/totp/verify', {
    code: code,
  }, { 'X-CSRF-Token': csrfToken });
  expect(verifyResult.status).toBe(200);
  console.log('TOTP verified');

  // Generate recovery codes
  var recoveryResult = await apiFetch(page, 'POST', BASE_URL + '/api/v1/auth/mfa/recovery-codes', null, {
    'X-CSRF-Token': csrfToken,
  });
  expect(recoveryResult.status).toBe(200);
  console.log('Recovery codes generated');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Live Connect Integration', function() {
  test.use({ storageState: undefined });

  test('full live connect activation lifecycle', async function({ page }) {
    // ---------------------------------------------------------------------------
    // Phase 1: API-based activation hitting the LIVE Connect server
    // ---------------------------------------------------------------------------
    console.log('\n=== Phase 1: Login ===');
    await login(page);
    await ensureSetup(page);

    // Verify initial state — not connected
    console.log('\n=== Phase 2: Check initial connect status ===');
    var statusBefore = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
    console.log('Initial status:', JSON.stringify(statusBefore.body).slice(0, 300));
    expect(statusBefore.body.connected).toBeFalsy();

    // Activate via API — this hits the REAL Connect server at connect.serv.libreloom.org
    console.log('\n=== Phase 3: Activate Connect via API (LIVE server) ===');
    var activateResp = await csrfRequest(page, 'PUT', BASE_URL + '/api/v1/connect/activate', {
      connect_key: CONNECT_KEY,
    });
    console.log('Activate status:', activateResp.status);
    expect(activateResp.ok).toBeTruthy();
    console.log('Activate response:', JSON.stringify(activateResp.body).slice(0, 500));
    expect(activateResp.body.connected).toBeTruthy();
    expect(activateResp.body.plan.name).toBe('Connect One');

    // Verify plan info from status
    var statusAfter = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
    expect(statusAfter.body.connected).toBeTruthy();

    // ---------------------------------------------------------------------------
    // Phase 4: Poll for auto-provisioning
    // The backend spins up a goroutine that provisions services for up to 2 minutes.
    // We poll every 3s for up to 60s waiting for all services to show "connected".
    // ---------------------------------------------------------------------------
    console.log('\n=== Phase 4: Poll for auto-provisioning (up to 60s) ===');
    var allProvisioned = false;
    for (var pi = 0; pi < 20; pi++) {
      await new Promise(function(r) { setTimeout(r, 3000); });
      var check = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
      var services = check.body.services || {};
      var states = Object.keys(services).map(function(k) { return k + '=' + (services[k] ? services[k].state : 'null'); }).join(', ');
      var allConnected = Object.values(services).every(function(s) { return s && s.state === 'connected'; });
      console.log('  Poll ' + (pi + 1) + ': ' + states);
      if (allConnected) {
        console.log('All services connected after ' + ((pi + 1) * 3) + 's');
        allProvisioned = true;
        break;
      }
    }

    // Final status snapshot after provisioning
    var statusAfterProvision = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
    console.log('\nFinal status after provisioning:', JSON.stringify(statusAfterProvision.body).slice(0, 500));

    // ---------------------------------------------------------------------------
    // Phase 5: Navigate browser to Settings → External Services
    // ---------------------------------------------------------------------------
    console.log('\n=== Phase 5: Navigate to Settings → External Services ===');
    await page.goto(BASE_URL + '/settings#external_services', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await new Promise(function(r) { setTimeout(r, 2000); });
    console.log('URL:', page.url());

    // Verify External Services category exists
    console.log('\n=== Phase 6: Verify External Services category ===');
    var category = page.locator('[data-slot="external-services-category"]');
    await expect(category).toBeVisible({ timeout: 10000 });
    console.log('External Services category visible');

    // ---------------------------------------------------------------------------
    // Phase 7: Verify ConnectStatusCard shows "Connected"
    // ---------------------------------------------------------------------------
    console.log('\n=== Phase 7: Verify ConnectStatusCard ===');
    var card = page.locator('[data-slot="connect-status-card"]');
    await expect(card).toBeVisible({ timeout: 10000 });
    console.log('ConnectStatusCard visible');

    // Check for "Connected" text on the card
    var connectedText = card.getByText('Connected', { exact: false });
    await expect(connectedText).toBeVisible({ timeout: 10000 });
    console.log('"Connected" text verified on card');

    // Check for plan badge
    var planBadge = page.locator('text=Connect One');
    await expect(planBadge).toBeVisible({ timeout: 5000 });
    console.log('Plan badge "Connect One" verified');

    // ---------------------------------------------------------------------------
    // Phase 8: Verify service badges are visible
    // ---------------------------------------------------------------------------
    console.log('\n=== Phase 8: Verify service badges ===');
    // Check that service status badges exist in the card
    var serviceBadges = card.locator('[data-slot*="service"]');
    var badgeCount = await serviceBadges.count();
    console.log('Service badges found:', badgeCount);
    expect(badgeCount).toBeGreaterThan(0);

    // Take screenshot of activated state
    console.log('\n=== Phase 9: Screenshot — Activated ===');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'live-connect-activated.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: live-connect-activated.png');

    // ---------------------------------------------------------------------------
    // Phase 10: Deactivate
    // ---------------------------------------------------------------------------
    console.log('\n=== Phase 10: Deactivate ===');
    var deactivateResp = await csrfRequest(page, 'POST', BASE_URL + '/api/v1/connect/deactivate', {});
    console.log('Deactivate status:', deactivateResp.status);
    expect(deactivateResp.ok).toBeTruthy();

    // Verify deactivation
    console.log('\n=== Phase 11: Verify deactivated ===');
    var statusAfterDeactivate = await csrfRequest(page, 'GET', BASE_URL + '/api/v1/connect/status', null);
    console.log('Status after deactivate:', JSON.stringify(statusAfterDeactivate.body).slice(0, 300));
    expect(statusAfterDeactivate.body.connected).toBeFalsy();

    // Refresh the settings page to see the disconnected state
    console.log('\n=== Phase 12: Screenshot — Deactivated ===');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(function(r) { setTimeout(r, 1500); });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'live-connect-deactivated.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: live-connect-deactivated.png');

    console.log('\n=== All live-connect phases passed ===');
  });
});
