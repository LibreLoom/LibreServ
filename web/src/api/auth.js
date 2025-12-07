/**
 * Auth API Module
 * 
 * Handles authentication-related API calls:
 * - Login/Logout
 * - Register
 * - Token refresh
 * - Get current user
 * - Change password
 */

import { api, tokens, onAuthChange } from './client';

/**
 * Login with username and password
 * @param {string} username 
 * @param {string} password 
 * @returns {Promise<{user: Object, tokens: Object}>}
 */
export async function login(username, password) {
  const response = await api.post('/auth/login', { username, password });
  
  // Store tokens
  if (response.tokens) {
    tokens.set(response.tokens.access_token, response.tokens.refresh_token);
  }
  
  return response;
}

/**
 * Register a new user
 * @param {string} username 
 * @param {string} password 
 * @param {string} email 
 * @returns {Promise<{message: string, user: Object}>}
 */
export async function register(username, password, email) {
  return api.post('/auth/register', { username, password, email });
}

/**
 * Get current authenticated user
 * @returns {Promise<Object>} User object
 */
export async function getCurrentUser() {
  return api.get('/auth/me');
}

/**
 * Change password for current user
 * @param {string} oldPassword 
 * @param {string} newPassword 
 * @returns {Promise<{message: string}>}
 */
export async function changePassword(oldPassword, newPassword) {
  return api.post('/auth/change-password', {
    old_password: oldPassword,
    new_password: newPassword,
  });
}

/**
 * Logout - clears tokens
 */
export function logout() {
  tokens.clear();
}

/**
 * Check if user is authenticated (has valid tokens)
 * @returns {boolean}
 */
export function isAuthenticated() {
  return !!tokens.accessToken;
}

/**
 * Validate current authentication by fetching user
 * Returns user if valid, null if not
 * @returns {Promise<Object|null>}
 */
export async function validateAuth() {
  if (!tokens.accessToken) {
    return null;
  }
  
  try {
    const user = await getCurrentUser();
    return user;
  } catch (error) {
    // If 401, tokens are invalid
    if (error.status === 401) {
      tokens.clear();
      return null;
    }
    throw error;
  }
}

// Re-export auth change listener
export { onAuthChange };
