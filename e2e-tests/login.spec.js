const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';

async function ensureSetup(page) {
  const statusResponse = await page.request.get(`${BASE_URL}/api/v1/setup/status`);
  const status = await statusResponse.json();
  
  // Only complete setup if pending, otherwise wait for it to be done
  if (status.setup_state?.status === 'pending') {
    const setupResponse = await page.request.post(`${BASE_URL}/api/v1/setup/complete`, {
      data: {
        admin_username: 'admin',
        admin_password: 'hunter2hunter2',
        admin_email: 'admin@example.com'
      }
    });
    expect(setupResponse.ok()).toBeTruthy();
  } else if (status.setup_state?.status === 'in_progress') {
    // Wait for setup to complete (another test is doing it)
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

test.describe('LibreServ Login', () => {
  test('should complete setup and login', async ({ page }) => {
    await ensureSetup(page);
    
    // Test login
    console.log('Testing login...');
    const loginResponse = await page.request.post(`${BASE_URL}/api/v1/auth/login`, {
      data: {
        username: 'admin',
        password: 'hunter2hunter2'
      }
    });
    
    const loginResult = await loginResponse.json();
    console.log('Login result:', loginResult);
    
    expect(loginResult.username).toBe('admin');
    expect(loginResult.role).toBe('admin');
    
    console.log('✓ Login test passed!');
  });
  
  test('should fail login with wrong password', async ({ page }) => {
    await ensureSetup(page);
    
    const response = await page.request.post(`${BASE_URL}/api/v1/auth/login`, {
      data: {
        username: 'admin',
        password: 'wrongpassword'
      }
    });
    
    expect(response.status()).toBe(401);
    console.log('✓ Wrong password test passed!');
  });
});
