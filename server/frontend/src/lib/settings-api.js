import api from "./api.js";

/**
 * Settings API client for the LibreServ settings management.
 * Provides methods for fetching and updating system settings.
 */

/**
 * Get current system settings
 * @returns {Promise<Object>} Settings object containing server and logging configuration
 * @returns {Promise<Object>} returns.server - Server configuration
 * @returns {Promise<string>} returns.server.host - Server host
 * @returns {Promise<number>} returns.server.port - Server port
 * @returns {Promise<string>} returns.server.mode - Server mode (development/production)
 * @returns {Promise<Object>} returns.logging - Logging configuration
 * @returns {Promise<string>} returns.logging.level - Log level (debug/info/warn/error)
 * @returns {Promise<string>} returns.logging.path - Log file path
 */
export async function getSettings() {
  const res = await api("/settings");
  return res.json();
}

/**
 * Update system settings
 * @param {Object} settings - Settings to update
 * @param {Object} settings.logging - Logging settings to update
 * @param {string} settings.logging.level - Log level (debug/info/warn/error)
 * @returns {Promise<Object>} Update result
 */
export async function updateSettings(settings) {
  const res = await api("/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}