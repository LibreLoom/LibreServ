const { test, expect } = require('@playwright/test');

test.describe('LibreServ Login', () => {
  test('should complete setup and login', async ({ page }) => {
    // First, complete setup if needed
    await page.goto('http://localhost:8080/api/v1/setup/status');
    const setupStatus = await page.evaluate(() => document.body.innerText);
    
    console.log('Setup status:', setupStatus);
    
    // If setup is pending, complete it
    if (setupStatus.includes('pending')) {
      console.log('Completing initial setup...');
      
      const setupResponse = await page.request.post('http://localhost:8080/api/v1/setup/complete', {
        data: {
          admin_username: 'admin',
          admin_password: 'hunter2hunter2',
          admin_email: 'admin@example.com'
        }
      });
      
      const setupResult = await setupResponse.json();
      console.log('Setup result:', setupResult);
      
      expect(setupResult.message).toBe('setup complete');
    }
    
    // Now test login
    console.log('Testing login...');
    const loginResponse = await page.request.post('http://localhost:8080/api/v1/auth/login', {
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
    const response = await page.request.post('http://localhost:8080/api/v1/auth/login', {
      data: {
        username: 'admin',
        password: 'wrongpassword'
      }
    });
    
    expect(response.status()).toBe(401);
    console.log('✓ Wrong password test passed!');
  });
});
