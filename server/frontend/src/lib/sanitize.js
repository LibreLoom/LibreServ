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
  const dangerousTags = /<(iframe|object|embed|form|input|textarea|button|select|option|style|link|meta|base|foreignObject)[^>]*>/gi;
  sanitized = sanitized.replace(dangerousTags, '');
  
  return sanitized;
}

/**
 * Sanitizes SVG markup for safe inline rendering.
 * Strips script elements, event handlers, foreignObject, and unsafe href values.
 * @param {string} svg - SVG markup string
 * @returns {string} - Sanitized SVG safe for dangerouslySetInnerHTML
 */
export function sanitizeSVG(svg) {
  if (!svg || typeof svg !== 'string') {
    return '';
  }
  if (!svg.includes('<svg')) {
    return '';
  }

  let sanitized = svg;

  // Remove all <script> elements entirely
  sanitized = sanitized.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove all <foreignObject> elements
  sanitized = sanitized.replace(/<foreignObject[^>]*>[\s\S]*?<\/foreignObject>/gi, '');

  // Strip event handler attributes from all elements
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '');

  // Strip href attributes with dangerous values
  sanitized = sanitized.replace(/\s+href\s*=\s*["']javascript:[^"']*["']/gi, ' href=""');
  sanitized = sanitized.replace(/\s+href\s*=\s*["']data:text\/html[^"']*["']/gi, ' href=""');
  sanitized = sanitized.replace(/\s+href\s*=\s*["']vbscript:[^"']*["']/gi, ' href=""');

  // Remove dangerous uses-elements that load external scripts
  sanitized = sanitized.replace(/<use[^>]*href\s*=\s*["'][^"']*\.js["'][^>]*\/>/gi, '');

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
