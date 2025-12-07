/**
 * Setup API Module
 * 
 * Handles initial setup API calls:
 * - Check setup status
 * - Complete setup
 */

import { api } from './client';

/**
 * Get setup status
 * @returns {Promise<{complete: boolean, ...}>}
 */
export async function getSetupStatus() {
  return api.get('/setup/status');
}

/**
 * Complete initial setup
 * @param {Object} setupData - Setup configuration
 * @param {string} setupData.username - Admin username
 * @param {string} setupData.password - Admin password
 * @param {string} setupData.email - Admin email
 * @returns {Promise<Object>}
 */
export async function completeSetup(setupData) {
  return api.post('/setup/complete', setupData);
}
