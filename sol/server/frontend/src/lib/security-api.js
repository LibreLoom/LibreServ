import api from "./api.js";

/**
 * Security API client for the Sol security monitoring system.
 * Provides methods for fetching security events, stats, and managing settings.
 */

/**
 * Get security events with optional filtering
 * @param {Object} filters - Filter options
 * @param {number} filters.limit - Maximum number of events to return
 * @param {string} filters.since - ISO timestamp to get events after
 * @param {string} filters.type - Event type filter
 * @param {string} filters.severity - Severity filter (info, warning, critical)
 * @returns {Promise<Array>} Security events
 */
/** @param {{ limit?: number, since?: string, type?: string, severity?: string }} [filters] */
export async function getSecurityEvents(filters = {}) {
  const params = new URLSearchParams();
  if (filters.limit) params.append("limit", /** @type {any} */ (filters.limit));
  if (filters.since) params.append("since", filters.since);
  if (filters.type) params.append("type", filters.type);
  if (filters.severity) params.append("severity", filters.severity);

  const queryString = params.toString();
  const path = `/security/events${queryString ? `?${queryString}` : ""}`;

  const res = await api(path);
  return res.json();
}

/**
 * Get security statistics
 * @param {Object} options - Options
 * @param {string} options.since - ISO timestamp for stats period
 * @returns {Promise<Object>} Security statistics
 */
/** @param {{ since?: string }} [options] */
export async function getSecurityStats(options = {}) {
  const params = new URLSearchParams();
  if (options.since) params.append("since", options.since);

  const queryString = params.toString();
  const path = `/security/stats${queryString ? `?${queryString}` : ""}`;

  const res = await api(path);
  return res.json();
}

/**
 * Get current user's security settings
 * @returns {Promise<Object>} Security settings
 */
export async function getSecuritySettings() {
  const res = await api("/settings/security");
  return res.json();
}

export async function updateSecuritySettings(settings, csrfToken) {
  const res = await api("/settings/security", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}

export async function sendTestNotification(csrfToken) {
  const res = await api("/settings/security/test", {
    method: "POST",
    headers: csrfToken ? { "X-CSRF-Token": csrfToken } : {},
  });
  return res.json();
}

export function getEventTypeDisplayName(eventType) {
  const names = {
    login_success: "Successful login",
    login_failed: "Failed login attempt",
    logout: "Logout",
    account_locked: "Account locked",
    account_unlocked: "Account unlocked",
    password_changed: "Password changed",
    password_reset: "Password reset",
    token_refresh: "Session refreshed",
    token_revoked: "Session ended",
    user_created: "User created",
    user_updated: "User updated",
    user_deleted: "User deleted",
    admin_action: "Admin action",
    settings_changed: "Settings changed",
    config_changed: "Configuration changed",
    app_installed: "App installed",
    app_updated: "App updated",
    app_removed: "App removed",
    app_started: "App started",
    app_stopped: "App stopped",
    route_created: "Route created",
    route_updated: "Route updated",
    route_deleted: "Route deleted",
    domain_added: "Domain added",
    certificate_issued: "Certificate issued",
    suspicious_activity: "Suspicious activity",
    brute_force_detected: "Brute force detected",
    token_reuse: "Suspicious token activity",
  };
  return names[eventType] || eventType.replace(/_/g, " ");
}

/**
 * Format timestamp for display
 * @param {string} timestamp - ISO timestamp
 * @param {boolean} use12Hour - Use 12-hour format
 * @returns {string} Formatted timestamp
 */
export function formatTimestamp(timestamp, use12Hour = false) {
  const date = /** @type {any} */ (new Date(timestamp));
  const now = /** @type {any} */ (new Date());
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;

  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
  const timeStr = date.toLocaleTimeString(use12Hour ? "en-US" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: use12Hour,
  });
  return `${dateStr} ${timeStr}`;
}
