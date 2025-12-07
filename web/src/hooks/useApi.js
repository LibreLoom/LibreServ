/**
 * Generic API Hook
 * 
 * Provides a reusable hook for API calls with loading, error, and data states.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Generic hook for API calls
 * @param {Function} apiFn - The API function to call
 * @param {Object} options - Hook options
 * @param {boolean} options.immediate - Whether to call immediately on mount
 * @param {Array} options.deps - Dependencies for automatic refetch
 * @param {any} options.initialData - Initial data value
 * @returns {Object} { data, error, isLoading, execute, reset }
 */
export function useApi(apiFn, options = {}) {
  const { immediate = false, deps = [], initialData = null } = options;
  
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Track if component is mounted
  const isMounted = useRef(true);
  
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);
  
  const execute = useCallback(async (...args) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await apiFn(...args);
      if (isMounted.current) {
        setData(result);
        return { success: true, data: result };
      }
    } catch (err) {
      if (isMounted.current) {
        setError(err);
        return { success: false, error: err };
      }
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, [apiFn]);
  
  const reset = useCallback(() => {
    setData(initialData);
    setError(null);
    setIsLoading(false);
  }, [initialData]);
  
  // Auto-execute on mount if immediate is true
  useEffect(() => {
    if (immediate) {
      execute();
    }
  }, [immediate, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  
  return { data, error, isLoading, execute, reset };
}

/**
 * Hook for mutations (POST, PUT, DELETE)
 * @param {Function} apiFn - The API function to call
 * @returns {Object} { mutate, data, error, isLoading, reset }
 */
export function useMutation(apiFn) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const isMounted = useRef(true);
  
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);
  
  const mutate = useCallback(async (...args) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await apiFn(...args);
      if (isMounted.current) {
        setData(result);
        return { success: true, data: result };
      }
    } catch (err) {
      if (isMounted.current) {
        setError(err);
        return { success: false, error: err };
      }
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, [apiFn]);
  
  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);
  
  return { mutate, data, error, isLoading, reset };
}

/**
 * Hook for polling data at intervals
 * @param {Function} apiFn - The API function to call
 * @param {number} interval - Polling interval in ms
 * @param {Object} options - Additional options
 * @param {boolean} options.enabled - Whether polling is enabled
 * @returns {Object} { data, error, isLoading, refetch }
 */
export function usePolling(apiFn, interval = 5000, options = {}) {
  const { enabled = true, initialData = null } = options;
  
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const isMounted = useRef(true);
  const intervalRef = useRef(null);
  
  useEffect(() => {
    isMounted.current = true;
    return () => { 
      isMounted.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);
  
  const fetch = useCallback(async () => {
    if (!isMounted.current) return;
    
    setIsLoading(true);
    try {
      const result = await apiFn();
      if (isMounted.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (isMounted.current) {
        setError(err);
      }
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, [apiFn]);
  
  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    
    // Initial fetch
    fetch();
    
    // Set up polling
    intervalRef.current = setInterval(fetch, interval);
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [enabled, interval, fetch]);
  
  return { data, error, isLoading, refetch: fetch };
}
