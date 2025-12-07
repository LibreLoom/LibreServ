import api from './client';

export const authApi = {
  // Check setup status
  async getSetupStatus() {
    return api.get('/setup/status');
  },

  // Complete initial setup
  async completeSetup(data) {
    const response = await api.post('/setup/complete', data);
    if (response.access_token) {
      api.setToken(response.access_token);
    }
    return response;
  },

  // Login
  async login(username, password) {
    const response = await api.post('/auth/login', { username, password });
    if (response.access_token) {
      api.setToken(response.access_token);
    }
    return response;
  },

  // Register (if allowed)
  async register(data) {
    const response = await api.post('/auth/register', data);
    if (response.access_token) {
      api.setToken(response.access_token);
    }
    return response;
  },

  // Refresh token
  async refreshToken(refreshToken) {
    const response = await api.post('/auth/refresh', { refresh_token: refreshToken });
    if (response.access_token) {
      api.setToken(response.access_token);
    }
    return response;
  },

  // Get current user
  async me() {
    return api.get('/auth/me');
  },

  // Change password
  async changePassword(currentPassword, newPassword) {
    return api.post('/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
  },

  // Logout
  logout() {
    api.setToken(null);
    localStorage.removeItem('libreserv-user');
    localStorage.removeItem('libreserv-refresh-token');
  },
};

export default authApi;
