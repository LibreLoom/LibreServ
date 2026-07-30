const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const SCREENSHOT_DIR = __dirname;

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

function generateTOTP(secret, timeOffset = 0) {
  const time = Math.floor(Date.now() / 1000) + timeOffset;
  const counter = Math.floor(time / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(counter));
  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(buffer);
  const digest = hmac.digest();
  const offset = digest[digest.length - 1] & 0xf;
  return ((digest[offset] & 0x7f) << 24 |
          (digest[offset + 1] & 0xff) << 16 |
          (digest[offset + 2] & 0xff) << 8 |
          (digest[offset + 3] & 0xff)).toString().padStart(6, '0').slice(-6);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureSetup(page) {
  const statusResponse = await page.request.get(`${BASE_URL}/api/v1/setup/status`);
  const status = await statusResponse.json();

  if (status.setup_state?.status === 'pending') {
    const setupHeaders = {};
    const token = process.env.E2E_SETUP_TOKEN;
    if (token) {
      setupHeaders['X-Setup-Token'] = token;
    }
    const setupResponse = await page.request.post(`${BASE_URL}/api/v1/setup/complete`, {
      headers: setupHeaders,
      data: {
        admin_username: 'admin',
        admin_password: 'hunter2hunter2',
        admin_email: 'admin@example.com'
      }
    });
    expect(setupResponse.ok()).toBeTruthy();
  } else if (status.setup_state?.status === 'in_progress') {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      const checkResponse = await page.request.get(`${BASE_URL}/api/v1/setup/status`);
      const checkStatus = await checkResponse.json();
      if (checkStatus.setup_state?.status === 'complete' || checkStatus.user_status?.setup_complete) {
        break;
      }
    }
  }
}

// Clear MFA on the admin user so login isn't challenged
function clearMFA() {
  const pythonScript = `
import sqlite3, bcrypt
conn = sqlite3.connect("/var/home/plainskill/Projects/LibreServ/server/backend/dev/data/libreserv.db")
hashed = bcrypt.hashpw(b"Admin12345678!", bcrypt.gensalt(12)).decode()
conn.execute("UPDATE users SET password_hash=?", (hashed,))
conn.execute("UPDATE users SET mfa_required=0")
tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type=?", ("table",)).fetchall()]
if "mfa_methods" in tables:
    conn.execute("DELETE FROM mfa_methods")
conn.commit()
conn.close()
print("Password reset, MFA cleared")
`;
  execSync(`distrobox enter dev -- python3 << 'PYEOF'
import sqlite3, bcrypt
conn = sqlite3.connect("/var/home/plainskill/Projects/LibreServ/server/backend/dev/data/libreserv.db")
hashed = bcrypt.hashpw(b"Admin12345678!", bcrypt.gensalt(12)).decode()
conn.execute("UPDATE users SET password_hash=?", (hashed,))
conn.execute("UPDATE users SET mfa_required=0")
tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type=?", ("table",)).fetchall()]
if "mfa_methods" in tables:
    conn.execute("DELETE FROM mfa_methods")
conn.commit()
conn.close()
print("Password reset, MFA cleared")
PYEOF
`, { stdio: 'inherit' });
}

// Try login; if MFA is required, clear it and retry once
async function login(page, username, password) {
  const resp = await page.request.post(`${BASE_URL}/api/v1/auth/login`, {
    data: { username, password },
  });
  const body = await resp.json();

  if (body.status === 'mfa_required') {
    console.log('MFA required during login — clearing MFA and retrying...');
    clearMFA();
    const retryResp = await page.request.post(`${BASE_URL}/api/v1/auth/login`, {
      data: { username, password },
    });
    return await retryResp.json();
  }
  return body;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Connect Integration', () => {
  test('full connect activation lifecycle', async ({ page }) => {
    await ensureSetup(page);

    // ---------------------------------------------------------------
    // 1. Login
    // ---------------------------------------------------------------
    console.log('\n=== Step 1: Login ===');
    const loginResult = await login(page, 'admin', 'hunter2hunter2');
    console.log('Login result:', JSON.stringify(loginResult).slice(0, 300));
    expect(loginResult.status).not.toBe('mfa_required');
    expect(loginResult.username || loginResult).toBeTruthy();

    // Verify session cookies are present
    const cookies = await page.context().cookies(BASE_URL);
    console.log('Session cookies:', cookies.map(c => c.name).join(', '));
    expect(cookies.length).toBeGreaterThan(0);

    // ---------------------------------------------------------------
    // 2. API flow: status → activate → status → deactivate → status
    // ---------------------------------------------------------------
    console.log('\n=== Step 2: API connect flow ===');

    // GET /connect/status (before activation)
    const statusBefore = await page.request.get(`${BASE_URL}/api/v1/connect/status`);
    const statusBeforeBody = await statusBefore.json();
    console.log('Connect status (before):', JSON.stringify(statusBeforeBody).slice(0, 300));

    // PUT /connect/activate — provision takes ~20s
    console.log('Activating connect...');
    const activateResp = await page.request.put(`${BASE_URL}/api/v1/connect/activate`);
    console.log('Activate status:', activateResp.status());
    const activateBody = await activateResp.json();
    console.log('Activate response:', JSON.stringify(activateBody).slice(0, 300));
    expect(activateResp.ok()).toBeTruthy();

    // Poll until all services show "connected"
    console.log('Polling for provisioning completion...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await page.request.get(`${BASE_URL}/api/v1/connect/status`);
      const body = await check.json();
      const services = body.services || {};
      const states = Object.values(services).map(s => s?.state).join(', ');
      const allConnected = Object.values(services).every(s => s?.state === 'connected');
      if (allConnected) {
        console.log(`All connected after ${i + 1}s  [${states}]`);
        break;
      }
      if (i % 5 === 0) {
        console.log(`  Poll ${i + 1}s: ${states}`);
      }
    }

    // GET /connect/status (after activation)
    const statusAfterActivate = await page.request.get(`${BASE_URL}/api/v1/connect/status`);
    const statusAfterActivateBody = await statusAfterActivate.json();
    console.log('Connect status (after activate):', JSON.stringify(statusAfterActivateBody).slice(0, 300));

    // POST /connect/deactivate
    console.log('Deactivating...');
    const deactivateResp = await page.request.post(`${BASE_URL}/api/v1/connect/deactivate`);
    console.log('Deactivate status:', deactivateResp.status());
    expect(deactivateResp.ok()).toBeTruthy();

    // GET /connect/status (after deactivate)
    const statusAfterDeactivate = await page.request.get(`${BASE_URL}/api/v1/connect/status`);
    const statusAfterDeactivateBody = await statusAfterDeactivate.json();
    console.log('Connect status (after deactivate):', JSON.stringify(statusAfterDeactivateBody).slice(0, 300));

    // ---------------------------------------------------------------
    // 3. Navigate directly to settings#external_services
    // ---------------------------------------------------------------
    console.log('\n=== Step 3: Navigate to settings ===');
    await page.goto(`${BASE_URL}/settings#external_services`, { waitUntil: 'domcontentloaded' });
    console.log('URL:', page.url());

    // ---------------------------------------------------------------
    // 4. Verify External Services category
    // ---------------------------------------------------------------
    console.log('\n=== Step 4: Verify External Services category ===');
    const category = page.locator('[data-slot="external-services-category"]');
    await expect(category).toBeVisible({ timeout: 10000 });
    console.log('External Services category visible');

    // ---------------------------------------------------------------
    // 5. Click "Add Connect" → fill key → click modal "Connect"
    // ---------------------------------------------------------------
    console.log('\n=== Step 5: Add Connect ===');
    const addConnectBtn = page.locator('button:has-text("Add Connect")');
    await expect(addConnectBtn).toBeVisible({ timeout: 5000 });
    await addConnectBtn.click();
    console.log('Clicked "Add Connect"');

    // Wait for modal/dialog
    await page.waitForSelector('[role="dialog"], [data-dialog]', { timeout: 5000 });
    console.log('Modal appeared');

    // Fill the key input
    const keyInput = page.locator('input[name="key"], input[placeholder*="key"], input[placeholder*="Key"]').first();
    await expect(keyInput).toBeVisible({ timeout: 5000 });
    await keyInput.fill('TEST-KEY-ABCD-EFGH');
    console.log('Filled key: TEST-KEY-ABCD-EFGH');

    // Click the modal "Connect" button — NOT the page-level "Add Connect" button
    // Strategy: find the dialog and click its Connect button
    const modalConnectBtn = page.locator('[role="dialog"] button:has-text("Connect"), [data-dialog] button:has-text("Connect")').first();
    await expect(modalConnectBtn).toBeVisible({ timeout: 5000 });
    await modalConnectBtn.click();
    console.log('Clicked modal "Connect" button');

    // ---------------------------------------------------------------
    // 6. Wait for provisioning (~20s)
    // ---------------------------------------------------------------
    console.log('\n=== Step 6: Wait for provisioning ===');
    console.log('Waiting 25s for services to provision...');
    await page.waitForTimeout(25000);

    // ---------------------------------------------------------------
    // 7. Verify "Connected" text and plan badge
    // ---------------------------------------------------------------
    console.log('\n=== Step 7: Verify Connected state ===');
    const connectedText = page.locator('text=Connected');
    await expect(connectedText).toBeVisible({ timeout: 10000 });
    console.log('"Connected" text visible');

    const planBadge = page.locator('text=Connect One');
    await expect(planBadge).toBeVisible({ timeout: 5000 });
    console.log('Plan badge "Connect One" visible');

    // ---------------------------------------------------------------
    // 8. Screenshot: connect-activated.png
    // ---------------------------------------------------------------
    console.log('\n=== Step 8: Screenshot activated ===');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'connect-activated.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: connect-activated.png');

    // ---------------------------------------------------------------
    // 9. Click "Disconnect" button
    // ---------------------------------------------------------------
    console.log('\n=== Step 9: Disconnect ===');
    const disconnectBtn = page.locator('button:has-text("Disconnect")').first();
    await expect(disconnectBtn).toBeVisible({ timeout: 5000 });
    await disconnectBtn.click();
    console.log('Clicked "Disconnect"');

    // ---------------------------------------------------------------
    // 10. Wait for "Add Connect" to reappear
    // ---------------------------------------------------------------
    console.log('\n=== Step 10: Wait for Add Connect ===');
    await expect(addConnectBtn).toBeVisible({ timeout: 10000 });
    console.log('"Add Connect" reappeared');

    // ---------------------------------------------------------------
    // 11. Screenshot: connect-deactivated.png
    // ---------------------------------------------------------------
    console.log('\n=== Step 11: Screenshot deactivated ===');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'connect-deactivated.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: connect-deactivated.png');

    console.log('\n=== All steps passed ===');
  });
});
