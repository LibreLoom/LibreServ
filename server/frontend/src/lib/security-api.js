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
  const res = await api("/security/settings");
  return res.json();
}

/**
 * Update security settings
 * @param {Object} settings - Security settings to update
 * @param {boolean} settings.notifications_enabled - Whether notifications are enabled
 * @param {string} settings.notification_frequency - Notification frequency (instant, normal, digest)
 * @param {boolean} settings.notify_on_login - Notify on successful logins
 * @param {boolean} settings.notify_on_failed_login - Notify on failed login attempts
 * @param {boolean} settings.notify_on_password_change - Notify on password changes
 * @param {boolean} settings.notify_on_admin_action - Notify on admin actions
 * @returns {Promise<Object>} Update result
 */
export async function updateSecuritySettings(settings) {
  const res = await api("/security/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}

/**
 * Send a test security notification
 * @returns {Promise<Object>} Test result
 */
export async function sendTestNotification() {
  const res = await api("/security/test-notification", {
    method: "POST",
  });
  return res.json();
}

/**
 * Get user-friendly event type display name
 * @param {string} eventType - Event type from API
 * @returns {string} Display name
 */
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
    info: "text-blue-600 bg-blue-50",
    warning: "text-yellow-600 bg-yellow-50",
    critical: "text-red-600 bg-red-50",
  };
  return colors[severity] || colors.info;
}

/**
 * Format timestamp for display
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Formatted timestamp
 */
export function formatTimestamp(timestamp) {
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

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}
