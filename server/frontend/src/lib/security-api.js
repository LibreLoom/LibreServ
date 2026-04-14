import api from "./api.js";

/**
 * Security API client for the LibreServ security monitoring system.
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
export async function getSecurityEvents(filters = {}) {
  const params = new URLSearchParams();
  if (filters.limit) params.append("limit", filters.limit);
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
    login_success: "Successful Login",
    login_failed: "Failed Login Attempt",
    logout: "Logout",
    account_locked: "Account Locked",
    account_unlocked: "Account Unlocked",
    password_changed: "Password Changed",
    password_reset: "Password Reset",
    token_refresh: "Token Refreshed",
    token_revoked: "Token Revoked",
    user_created: "User Created",
    user_updated: "User Updated",
    user_deleted: "User Deleted",
    admin_action: "Admin Action",
    settings_changed: "Settings Changed",
    config_changed: "Configuration Changed",
    app_installed: "App Installed",
    app_updated: "App Updated",
    app_removed: "App Removed",
    app_started: "App Started",
    app_stopped: "App Stopped",
    route_created: "Route Created",
    route_updated: "Route Updated",
    route_deleted: "Route Deleted",
    domain_added: "Domain Added",
    certificate_issued: "Certificate Issued",
    suspicious_activity: "Suspicious Activity",
    brute_force_detected: "Brute Force Detected",
    token_reuse: "Suspicious Token Activity",
  };
  return names[eventType] || eventType.replace(/_/g, " ");
}

/**
 * Get severity color for UI
 * @param {string} severity - Severity level
 * @returns {string} CSS color class
 */
export function getSeverityColor(severity) {
  const colors = {
    info: "text-accent bg-secondary/10",
    warning: "text-warning bg-warning/10",
    critical: "text-error bg-error/10",
  };
  return colors[severity] || colors.info;
}

/**
 * Format timestamp for display
 * @param {string} timestamp - ISO timestamp
 * @param {boolean} use12Hour - Use 12-hour format
 * @returns {string} Formatted timestamp
 */
export function formatTimestamp(timestamp, use12Hour = false) {
  const date = new Date(timestamp);
  const now = new Date();
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
