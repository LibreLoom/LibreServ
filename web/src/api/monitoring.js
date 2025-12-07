/**
 * Monitoring API Module
 * 
 * Handles monitoring and health-related API calls:
 * - System health
 * - App health and metrics
 * - Metrics history
 */

import { api } from './client';

/**
 * Get overall system health status
 * @returns {Promise<{status: string, timestamp: string, checks: Object}>}
 */
export async function getSystemHealth() {
  return api.get('/monitoring/system');
}

/**
 * Get health status for a specific app
 * @param {string} appId - The app ID
 * @returns {Promise<Object>} Health status
 */
export async function getAppHealth(appId) {
  return api.get(`/apps/${appId}/health`);
}

/**
 * Get current metrics for a specific app
 * @param {string} appId - The app ID
 * @returns {Promise<Object>} Current metrics
 */
export async function getAppMetrics(appId) {
  return api.get(`/apps/${appId}/metrics`);
}

/**
 * Get historical metrics for a specific app
 * @param {string} appId - The app ID
 * @param {Object} options - Query options
 * @param {string} options.since - ISO timestamp for start of history
 * @param {number} options.limit - Maximum number of records
 * @returns {Promise<{app_id: string, since: string, limit: number, count: number, metrics: Array}>}
 */
export async function getAppMetricsHistory(appId, options = {}) {
  const params = new URLSearchParams();
  if (options.since) params.append('since', options.since);
  if (options.limit) params.append('limit', options.limit.toString());
  
  const queryString = params.toString();
  const endpoint = `/apps/${appId}/metrics/history${queryString ? `?${queryString}` : ''}`;
  return api.get(endpoint);
}

/**
 * Register health checks for an app
 * @param {string} appId - The app ID
 * @param {Object} config - Health check configuration
 * @returns {Promise<{status: string, app_id: string, message: string}>}
 */
export async function registerHealthCheck(appId, config) {
  return api.post(`/apps/${appId}/health/register`, config);
}

/**
 * Unregister health checks for an app
 * @param {string} appId - The app ID
 * @returns {Promise<{status: string, app_id: string, message: string}>}
 */
export async function unregisterHealthCheck(appId) {
  return api.delete(`/apps/${appId}/health`);
}

/**
 * Clean up old monitoring data
 * @param {number} retentionDays - Number of days to retain (default: 7)
 * @returns {Promise<{status: string, retention_days: number, message: string}>}
 */
export async function cleanupMetrics(retentionDays = 7) {
  return api.post(`/monitoring/cleanup?retention_days=${retentionDays}`);
}
