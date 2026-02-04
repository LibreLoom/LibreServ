/**
 * Error Reporting Utilities
 * 
 * Provides centralized error handling and reporting for the application.
 * In production, these would send errors to a service like Sentry.
 */

/**
 * Report an error to the error tracking service
 * In development, logs to console. In production, sends to external service.
 * 
 * @param {Error} error - The error object
 * @param {Object} context - Additional context about the error
 */
export function reportError(error, context = {}) {
  // Generate a unique error ID
  const errorId = generateErrorId();
  
  // Add error ID to context
  const enrichedContext = {
    ...context,
    errorId,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
  };

  if (process.env.NODE_ENV === 'development') {
    console.group(`🐛 Error Report [${errorId}]`);
    console.error('Error:', error);
    console.log('Context:', enrichedContext);
    console.groupEnd();
  } else {
    // In production, send to error tracking service
    // Example: Sentry, LogRocket, etc.
    // Sentry.captureException(error, { extra: enrichedContext });
    
    // For now, log to console in production too (but could be removed)
    console.error(`[Error ${errorId}]`, error.message);
  }

  return errorId;
}

/**
 * Set up global error handlers
 * Call this once when the app initializes
 */
export function setupGlobalErrorHandlers() {
  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason instanceof Error 
      ? event.reason 
      : new Error(String(event.reason));
    
    reportError(error, {
      type: 'unhandledrejection',
      source: 'window',
    });
  });

  // Handle global errors
  window.addEventListener('error', (event) => {
    reportError(event.error || new Error(event.message), {
      type: 'error',
      source: 'window',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  // Handle rejected promises in React (if using React 16+ error boundaries)
  if (window.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__) {
    const originalErrorHandler = console.error;
    console.error = function(...args) {
      // Check if this is a React error
      const errorMessage = args[0];
      if (typeof errorMessage === 'string' && errorMessage.includes('React')) {
        reportError(new Error(errorMessage), {
          type: 'react',
          source: 'console',
          args: args.slice(1),
        });
      }
      originalErrorHandler.apply(console, args);
    };
  }
}

/**
 * Generate a unique error ID
 * @returns {string} Unique error identifier
 */
function generateErrorId() {
  return Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Wrap an async function with error reporting
 * 
 * @param {Function} fn - Async function to wrap
 * @param {string} operationName - Name of the operation for context
 * @returns {Function} Wrapped function
 */
export function withErrorReporting(fn, operationName) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      reportError(error, {
        operation: operationName,
        args: args.map(arg => 
          typeof arg === 'object' ? '[Object]' : String(arg)
        ),
      });
      throw error;
    }
  };
}

/**
 * Create a safe version of a function that catches and reports errors
 * 
 * @param {Function} fn - Function to make safe
 * @param {*} defaultValue - Value to return on error
 * @returns {Function} Safe function
 */
export function makeSafe(fn, defaultValue = null) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      reportError(error, {
        operation: fn.name || 'anonymous',
        type: 'sync',
      });
      return defaultValue;
    }
  };
}

/**
 * Assert that a condition is true, otherwise throw an error
 * 
 * @param {*} condition - Condition to check
 * @param {string} message - Error message if condition is falsy
 * @throws {Error} If condition is falsy
 */
export function assert(condition, message) {
  if (!condition) {
    const error = new Error(message || 'Assertion failed');
    reportError(error, {
      type: 'assertion',
    });
    throw error;
  }
}

/**
 * Safely parse JSON with error reporting
 * 
 * @param {string} jsonString - JSON string to parse
 * @param {*} defaultValue - Value to return on error
 * @returns {*} Parsed object or default value
 */
export function safeJsonParse(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    reportError(error, {
      operation: 'JSON.parse',
      type: 'parsing',
    });
    return defaultValue;
  }
}

/**
 * Safely access nested object properties
 * 
 * @param {Object} obj - Object to access
 * @param {string} path - Path to property (e.g., 'user.profile.name')
 * @param {*} defaultValue - Default value if path doesn't exist
 * @returns {*} Property value or default
 */
export function safeGet(obj, path, defaultValue = null) {
  try {
    const keys = path.split('.');
    let result = obj;
    
    for (const key of keys) {
      if (result == null || typeof result !== 'object') {
        return defaultValue;
      }
      result = result[key];
    }
    
    return result !== undefined ? result : defaultValue;
  } catch (error) {
    reportError(error, {
      operation: 'safeGet',
      path,
    });
    return defaultValue;
  }
}

export default {
  reportError,
  setupGlobalErrorHandlers,
  withErrorReporting,
  makeSafe,
  assert,
  safeJsonParse,
  safeGet,
};
