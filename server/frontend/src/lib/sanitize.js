/**
 * Sanitization utilities to prevent XSS attacks
 */

/**
 * Sanitizes a string for safe display in HTML
 * Removes potentially dangerous HTML tags and attributes
 * @param {string} str - The string to sanitize
 * @returns {string} - Sanitized string safe for HTML display
 */
export function sanitizeHTML(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  
  // Create a temporary div to use the browser's HTML escaping
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Sanitizes a string for safe display as text content
 * Removes all HTML tags completely
 * @param {string} str - The string to sanitize
 * @returns {string} - Plain text with HTML removed
 */
export function stripHTML(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  
  // Remove script tags and their content
  let sanitized = str.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  
  // Remove event handlers
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*["']?[^"'>]*["']?/gi, '');
  
  // Remove javascript: URLs
  sanitized = sanitized.replace(/javascript:/gi, '');
  
  // Remove data: URLs that could contain scripts
  sanitized = sanitized.replace(/data:text\/html/gi, '');
  
  // Remove other dangerous tags
  const dangerousTags = /<(iframe|object|embed|form|input|textarea|button|select|option|style|link|meta|base)[^>]*>/gi;
  sanitized = sanitized.replace(dangerousTags, '');
  
  return sanitized;
}

/**
 * Sanitizes a string for safe use in URLs
 * @param {string} str - The string to sanitize
 * @returns {string} - Sanitized URL
 */
export function sanitizeURL(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  
  // Remove javascript: and data: protocols
  const lower = str.toLowerCase().trim();
  if (lower.startsWith('javascript:') || 
      lower.startsWith('data:') || 
      lower.startsWith('vbscript:') ||
      lower.startsWith('file:')) {
    return '';
  }
  
  return str;
}

/**
 * Sanitizes event details for display in the security activity log
 * This is a specialized function that handles the specific fields we display
 * @param {Object} event - The security event object
 * @returns {Object} - Event with sanitized fields
 */
export function sanitizeEvent(event) {
  if (!event) return event;
  
  return {
    ...event,
    details: stripHTML(event.details || ''),
    actor_username: stripHTML(event.actor_username || ''),
    ip_address: stripHTML(event.ip_address || ''),
    user_agent: stripHTML(event.user_agent || ''),
  };
}
