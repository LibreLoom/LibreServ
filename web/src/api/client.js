/**
 * API Client for LibreServ Backend
 * 
 * Handles authentication tokens, automatic refresh, and provides
 * a consistent interface for all API calls.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

// Token storage keys
const ACCESS_TOKEN_KEY = 'libreserv-access-token';
const REFRESH_TOKEN_KEY = 'libreserv-refresh-token';

// Token management
export const tokens = {
  get accessToken() {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  get refreshToken() {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  set(accessToken, refreshToken) {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

// Event emitter for auth state changes
const authListeners = new Set();

export const onAuthChange = (callback) => {
  authListeners.add(callback);
  return () => authListeners.delete(callback);
};

const emitAuthChange = (event) => {
  authListeners.forEach((cb) => cb(event));
};

// Flag to prevent multiple simultaneous refresh attempts
let isRefreshing = false;
let refreshPromise = null;

/**
 * Refresh the access token using the refresh token
 */
async function refreshAccessToken() {
  const refreshToken = tokens.refreshToken;
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    tokens.clear();
    emitAuthChange({ type: 'logout', reason: 'refresh_failed' });
    throw new Error('Token refresh failed');
  }

  const data = await response.json();
  tokens.set(data.access_token, data.refresh_token);
  return data.access_token;
}

/**
 * API client with automatic token handling
 */
class ApiClient {
  constructor(baseUrl = API_BASE) {
    this.baseUrl = baseUrl;
  }

  /**
   * Build headers for requests
   */
  buildHeaders(customHeaders = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    const accessToken = tokens.accessToken;
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    return headers;
  }

  /**
   * Make an API request with automatic token refresh
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const { headers: customHeaders, ...restOptions } = options;

    const fetchOptions = {
      ...restOptions,
      headers: this.buildHeaders(customHeaders),
    };

    let response = await fetch(url, fetchOptions);

    // If unauthorized, try to refresh token and retry
    if (response.status === 401 && tokens.refreshToken) {
      try {
        // Prevent multiple simultaneous refresh attempts
        if (!isRefreshing) {
          isRefreshing = true;
          refreshPromise = refreshAccessToken();
        }

        await refreshPromise;
        isRefreshing = false;
        refreshPromise = null;

        // Retry the original request with new token
        fetchOptions.headers = this.buildHeaders(customHeaders);
        response = await fetch(url, fetchOptions);
      } catch (error) {
        isRefreshing = false;
        refreshPromise = null;
        throw error;
      }
    }

    return this.handleResponse(response);
  }

  /**
   * Handle API response
   */
  async handleResponse(response) {
    // Handle empty responses (204 No Content)
    if (response.status === 204) {
      return { success: true };
    }

    const contentType = response.headers.get('content-type');
    const isJson = contentType && contentType.includes('application/json');
    const data = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const error = new Error(data.error || data.message || 'API request failed');
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  // HTTP method shortcuts
  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  post(endpoint, body, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  put(endpoint, body, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  patch(endpoint, body, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }
}

// Export singleton instance
export const api = new ApiClient();

// Export class for testing or custom instances
export { ApiClient };
