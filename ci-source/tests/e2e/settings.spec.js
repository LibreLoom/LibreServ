const { test, expect } = require('@playwright/test');

test.describe('LibreServ Settings', () => {
  test('should show backend API settings with correct values', async ({ request }) => {
    // Login first to get session
    const loginResponse = await request.post('http://localhost:8080/api/v1/auth/login', {
      data: {
        username: 'admin',
        password: 'hunter2hunter2'
      }
    });
    
    expect(loginResponse.ok()).toBeTruthy();
    
    // Get settings
    const settingsResponse = await request.get('http://localhost:8080/api/v1/settings');
    expect(settingsResponse.ok()).toBeTruthy();
    
    const settings = await settingsResponse.json();
    console.log('Settings response:', JSON.stringify(settings, null, 2));
    
    // Verify backend settings exist and have values
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
    // Login first
    await request.post('http://localhost:8080/api/v1/auth/login', {
      data: {
        username: 'admin',
        password: 'hunter2hunter2'
      }
    });
    
    // Get settings
    const settingsResponse = await request.get('http://localhost:8080/api/v1/settings');
    const settings = await settingsResponse.json();
    
    // Check if proxy settings exist
    if (settings.proxy) {
      expect(settings.proxy.type).toBe('caddy');
      console.log('✓ Proxy settings:', settings.proxy);
      
      // At minimum, proxy should have type and auto_https
      expect(settings.proxy.type).toBeDefined();
      expect(settings.proxy).toHaveProperty('auto_https');
    } else {
      console.log('ℹ Proxy settings not configured (this is acceptable if caddy is disabled)');
    }
  });

  test('should show logging settings with correct values', async ({ request }) => {
    // Login first
    await request.post('http://localhost:8080/api/v1/auth/login', {
      data: {
        username: 'admin',
        password: 'hunter2hunter2'
      }
    });
    
    // Get settings
    const settingsResponse = await request.get('http://localhost:8080/api/v1/settings');
    const settings = await settingsResponse.json();
    
    // Verify logging settings
    expect(settings.logging).toBeDefined();
    expect(settings.logging.level).toBeDefined();
    expect(settings.logging.level).toMatch(/^(debug|info|warn|error)$/);
    
    console.log('✓ Logging settings:', settings.logging);
  });
});
