/**
 * Apps Hooks
 * 
 * React hooks for app management operations
 */

import { useCallback, useMemo } from 'react';
import { useApi, useMutation, usePolling } from './useApi';
import * as appsApi from '../api/apps';

/**
 * Hook for listing installed apps
 * @param {Object} options
 * @param {boolean} options.poll - Enable polling
 * @param {number} options.pollInterval - Polling interval in ms
 */
export function useApps(options = {}) {
  const { poll = false, pollInterval = 10000 } = options;
  
  // Use polling if enabled, otherwise use regular api hook
  const polling = usePolling(appsApi.listApps, pollInterval, { enabled: poll });
  const api = useApi(appsApi.listApps, { immediate: !poll });
  
  const result = poll ? polling : api;
  
  // Extract apps array from response
  const apps = useMemo(() => {
    return result.data?.apps || [];
  }, [result.data]);
  
  const total = result.data?.total || 0;
  
  return {
    apps,
    total,
    isLoading: result.isLoading,
    error: result.error,
    refetch: poll ? result.refetch : result.execute,
  };
}

/**
 * Hook for getting a single app's details
 * @param {string} instanceId - The app instance ID
 */
export function useApp(instanceId) {
  const fetchApp = useCallback(() => {
    if (!instanceId) return Promise.resolve(null);
    return appsApi.getApp(instanceId);
  }, [instanceId]);
  
  const { data, error, isLoading, execute } = useApi(fetchApp, {
    immediate: !!instanceId,
    deps: [instanceId],
  });
  
  return {
    app: data,
    isLoading,
    error,
    refetch: execute,
  };
}

/**
 * Hook for getting app status with polling
 * @param {string} instanceId - The app instance ID
 * @param {Object} options
 */
export function useAppStatus(instanceId, options = {}) {
  const { pollInterval = 5000, enabled = true } = options;
  
  const fetchStatus = useCallback(() => {
    if (!instanceId) return Promise.resolve(null);
    return appsApi.getAppStatus(instanceId);
  }, [instanceId]);
  
  return usePolling(fetchStatus, pollInterval, { enabled: enabled && !!instanceId });
}

/**
 * Hook for app actions (start, stop, restart, update)
 */
export function useAppActions(instanceId) {
  const startMutation = useMutation(appsApi.startApp);
  const stopMutation = useMutation(appsApi.stopApp);
  const restartMutation = useMutation(appsApi.restartApp);
  const updateMutation = useMutation(appsApi.updateApp);
  const uninstallMutation = useMutation(appsApi.uninstallApp);
  
  const start = useCallback(() => startMutation.mutate(instanceId), [instanceId, startMutation]);
  const stop = useCallback(() => stopMutation.mutate(instanceId), [instanceId, stopMutation]);
  const restart = useCallback(() => restartMutation.mutate(instanceId), [instanceId, restartMutation]);
  const update = useCallback(() => updateMutation.mutate(instanceId), [instanceId, updateMutation]);
  const uninstall = useCallback(() => uninstallMutation.mutate(instanceId), [instanceId, uninstallMutation]);
  
  const isLoading = 
    startMutation.isLoading || 
    stopMutation.isLoading || 
    restartMutation.isLoading || 
    updateMutation.isLoading ||
    uninstallMutation.isLoading;
  
  return {
    start,
    stop,
    restart,
    update,
    uninstall,
    isLoading,
    startState: startMutation,
    stopState: stopMutation,
    restartState: restartMutation,
    updateState: updateMutation,
    uninstallState: uninstallMutation,
  };
}

/**
 * Hook for installing apps
 */
export function useInstallApp() {
  const { mutate, data, error, isLoading, reset } = useMutation(
    (appId, name, config) => appsApi.installApp(appId, name, config)
  );
  
  return {
    install: mutate,
    result: data,
    error,
    isLoading,
    reset,
  };
}

/**
 * Hook for catalog operations
 */
export function useCatalog(options = {}) {
  const { immediate = true } = options;
  
  const { data: apps, error: appsError, isLoading: appsLoading, execute: refetchApps } = 
    useApi(appsApi.listCatalogApps, { immediate });
  
  const { data: categories, error: categoriesError, isLoading: categoriesLoading, execute: refetchCategories } = 
    useApi(appsApi.getCatalogCategories, { immediate });
  
  const refreshMutation = useMutation(appsApi.refreshCatalog);
  
  const refresh = useCallback(async () => {
    await refreshMutation.mutate();
    await Promise.all([refetchApps(), refetchCategories()]);
  }, [refreshMutation, refetchApps, refetchCategories]);
  
  return {
    apps: apps || [],
    categories: categories || [],
    isLoading: appsLoading || categoriesLoading,
    error: appsError || categoriesError,
    refresh,
    isRefreshing: refreshMutation.isLoading,
  };
}
