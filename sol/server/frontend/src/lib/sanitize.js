/**
 * Sanitization utilities to prevent XSS attacks
 */

/**
 * Sanitizes a string for safe display as text content
 * Removes all HTML tags completely using DOMPurify
 * @param {string} str - The string to sanitize
 * @returns {string} - Plain text with HTML removed
 */
export function stripHTML(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Sanitizes a string for safe use in URLs
 * Uses URL parser to validate, only allows http/https/mailto schemes.
 * @param {string} str - The string to sanitize
 * @returns {string} - Sanitized URL or empty string if invalid
 */
export function sanitizeURL(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  try {
    const url = new URL(str, window.location.origin);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return '';
    }
    return str;
  } catch {
    return '';
  }
}
