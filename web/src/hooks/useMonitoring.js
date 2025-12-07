/**
 * Monitoring Hooks
 * 
 * React hooks for monitoring and health operations
 */

import { useCallback } from 'react';
import { useApi, usePolling } from './useApi';
import * as monitoringApi from '../api/monitoring';

/**
 * Hook for system health with polling
 * @param {Object} options
 * @param {number} options.pollInterval - Polling interval in ms (default: 30000)
 * @param {boolean} options.enabled - Whether polling is enabled
 */
export function useSystemHealth(options = {}) {
  const { pollInterval = 30000, enabled = true } = options;
  
  return usePolling(monitoringApi.getSystemHealth, pollInterval, { enabled });
}

/**
 * Hook for app health with polling
 * @param {string} appId - The app ID
 * @param {Object} options
 */
export function useAppHealth(appId, options = {}) {
  const { pollInterval = 10000, enabled = true } = options;
  
  const fetchHealth = useCallback(() => {
    if (!appId) return Promise.resolve(null);
    return monitoringApi.getAppHealth(appId);
  }, [appId]);
  
  return usePolling(fetchHealth, pollInterval, { enabled: enabled && !!appId });
}

/**
 * Hook for app metrics with polling
 * @param {string} appId - The app ID
 * @param {Object} options
 */
export function useAppMetrics(appId, options = {}) {
  const { pollInterval = 5000, enabled = true } = options;
  
  const fetchMetrics = useCallback(() => {
    if (!appId) return Promise.resolve(null);
    return monitoringApi.getAppMetrics(appId);
  }, [appId]);
  
  return usePolling(fetchMetrics, pollInterval, { enabled: enabled && !!appId });
}

/**
 * Hook for app metrics history
 * @param {string} appId - The app ID
 * @param {Object} historyOptions - Query options (since, limit)
 */
export function useAppMetricsHistory(appId, historyOptions = {}) {
  const fetchHistory = useCallback(() => {
    if (!appId) return Promise.resolve(null);
    return monitoringApi.getAppMetricsHistory(appId, historyOptions);
  }, [appId, historyOptions]);
  
  return useApi(fetchHistory, {
    immediate: !!appId,
    deps: [appId, JSON.stringify(historyOptions)],
  });
}
