/**
 * Apps API Module
 * 
 * Handles app management API calls:
 * - List installed apps
 * - Get app details
 * - Install/uninstall apps
 * - Start/stop/restart apps
 * - Update apps
 * - Get app status
 */

import { api } from './client';

/**
 * List all installed apps
 * @returns {Promise<{apps: Array, total: number}>}
 */
export async function listApps() {
  return api.get('/apps');
}

/**
 * Get details for a specific installed app
 * @param {string} instanceId - The instance ID of the installed app
 * @returns {Promise<Object>} App details
 */
export async function getApp(instanceId) {
  return api.get(`/apps/${instanceId}`);
}

/**
 * Get status for a specific app
 * @param {string} instanceId - The instance ID
 * @returns {Promise<Object>} App status
 */
export async function getAppStatus(instanceId) {
  return api.get(`/apps/${instanceId}/status`);
}

/**
 * Install a new app from the catalog
 * @param {string} appId - The catalog app ID
 * @param {string} name - Optional custom name for the instance
 * @param {Object} config - App configuration
 * @returns {Promise<Object>} Installation result
 */
export async function installApp(appId, name = '', config = {}) {
  return api.post('/apps', {
    app_id: appId,
    name,
    config,
  });
}

/**
 * Uninstall an app
 * @param {string} instanceId - The instance ID
 * @returns {Promise<{message: string}>}
 */
export async function uninstallApp(instanceId) {
  return api.delete(`/apps/${instanceId}`);
}

/**
 * Start an app
 * @param {string} instanceId - The instance ID
 * @returns {Promise<{message: string, instance_id: string}>}
 */
export async function startApp(instanceId) {
  return api.post(`/apps/${instanceId}/start`);
}

/**
 * Stop an app
 * @param {string} instanceId - The instance ID
 * @returns {Promise<{message: string, instance_id: string}>}
 */
export async function stopApp(instanceId) {
  return api.post(`/apps/${instanceId}/stop`);
}

/**
 * Restart an app
 * @param {string} instanceId - The instance ID
 * @returns {Promise<{message: string, instance_id: string}>}
 */
export async function restartApp(instanceId) {
  return api.post(`/apps/${instanceId}/restart`);
}

/**
 * Update an app to the latest version
 * @param {string} instanceId - The instance ID
 * @returns {Promise<{message: string, instance_id: string}>}
 */
export async function updateApp(instanceId) {
  return api.post(`/apps/${instanceId}/update`);
}

// ============================================
// Catalog API
// ============================================

/**
 * List available apps in the catalog
 * @returns {Promise<Array>} List of available apps
 */
export async function listCatalogApps() {
  return api.get('/catalog');
}

/**
 * Get catalog app categories
 * @returns {Promise<Array>} List of categories
 */
export async function getCatalogCategories() {
  return api.get('/catalog/categories');
}

/**
 * Get details for a catalog app
 * @param {string} appId - The catalog app ID
 * @returns {Promise<Object>} App details
 */
export async function getCatalogApp(appId) {
  return api.get(`/catalog/${appId}`);
}

/**
 * Refresh the catalog (fetch latest from source)
 * @returns {Promise<Object>}
 */
export async function refreshCatalog() {
  return api.post('/catalog/refresh');
}
