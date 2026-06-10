const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';

async function ensureSetup(request) {
  const statusResponse = await request.get(`${BASE_URL}/api/v1/setup/status`);
  const status = await statusResponse.json();
  
  if (status.setup_state?.status === 'pending') {
    const setupHeaders = {};
    const token = process.env.E2E_SETUP_TOKEN;
    if (token) {
      setupHeaders['X-Setup-Token'] = token;
    }
    const setupResponse = await request.post(`${BASE_URL}/api/v1/setup/complete`, {
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
      const checkResponse = await request.get(`${BASE_URL}/api/v1/setup/status`);
      const checkStatus = await checkResponse.json();
      if (checkStatus.setup_state?.status === 'complete' || checkStatus.user_status?.setup_complete) {
        break;
      }
    }
  }
}

async function login(request) {
  await ensureSetup(request);
  
  const loginResponse = await request.post(`${BASE_URL}/api/v1/auth/login`, {
    data: {
      username: 'admin',
      password: 'hunter2hunter2'
    }
  });
  
  expect(loginResponse.ok()).toBeTruthy();
  
  // Extract the access token cookie from Set-Cookie header
  const setCookie = loginResponse.headers()['set-cookie'] || '';
  const match = setCookie.match(/libreserv_access=([^;]+)/);
  if (match) {
    return { token: match[1] };
  }
  
  // Fallback: try body tokens
  const body = await loginResponse.json();
  return { token: body.tokens?.access_token || '' };
}

test.describe('LibreServ Settings', () => {
  test('should show backend API settings with correct values', async ({ request }) => {
    const { token } = await login(request);
    
    const settingsResponse = await request.get(`${BASE_URL}/api/v1/settings`, {
      headers: { 'Cookie': `libreserv_access=${token}` }
    });
    expect(settingsResponse.ok()).toBeTruthy();
    
    const settings = await settingsResponse.json();
    console.log('Settings response:', JSON.stringify(settings, null, 2));
    
    expect(settings.server).toBeDefined();
    expect(settings.server.host).toBeDefined();
    expect(settings.server.port).toBeDefined();
    expect(settings.server.mode).toBeDefined();
    
    expect(settings.server.host).not.toBe('');
    expect(settings.server.port).toBeGreaterThan(0);
    expect(settings.server.mode).not.toBe('');
    
    console.log('✓ Server settings:', settings.server);
  });

  test('should show proxy settings when caddy is configured', async ({ request }) => {
    const { token } = await login(request);
    
    const settingsResponse = await request.get(`${BASE_URL}/api/v1/settings`, {
      headers: { 'Cookie': `libreserv_access=${token}` }
    });
    const settings = await settingsResponse.json();
    
    if (settings.proxy) {
      expect(settings.proxy.type).toBe('caddy');
      console.log('✓ Proxy settings:', settings.proxy);
      
      expect(settings.proxy.type).toBeDefined();
      expect(settings.proxy).toHaveProperty('auto_https');
    } else {
      console.log('ℹ Proxy settings not configured (this is acceptable if caddy is disabled)');
    }
  });

  test('should show logging settings with correct values', async ({ request }) => {
    const { token } = await login(request);
    
    const settingsResponse = await request.get(`${BASE_URL}/api/v1/settings`, {
      headers: { 'Cookie': `libreserv_access=${token}` }
    });
    const settings = await settingsResponse.json();
    
    expect(settings.logging).toBeDefined();
    expect(settings.logging.level).toBeDefined();
    expect(settings.logging.level).toMatch(/^(debug|info|warn|error)$/);
    
    console.log('✓ Logging settings:', settings.logging);
  });
});
