/**
 * API Module Index
 * 
 * Central export point for all API modules
 */

// Re-export everything from individual modules
export * from './client';
export * from './auth';
export * from './apps';
export * from './monitoring';
export * from './setup';

// Named module exports for namespaced access
import * as authApi from './auth';
import * as appsApi from './apps';
import * as monitoringApi from './monitoring';
import * as setupApi from './setup';

export { authApi, appsApi, monitoringApi, setupApi };
