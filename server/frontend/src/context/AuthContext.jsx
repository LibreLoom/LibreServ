import { useState } from "react";
import api from "../lib/api";
import { AuthContext } from "./AuthContextContext";
import { useEffect } from "react";

export function AuthProvider({ children }) {
  // State to store the current user information
  const [me, setMe] = useState(null);
  // State to store the CSRF token for write operations
  const [csrfToken, setCsrfToken] = useState(null);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    async function initAuth() {
      // Populate session + CSRF once on load so the UI can render confidently.
      // Bootstrap from existing cookies so refreshes preserve the session.
      try {
        const meResponse = await api("/auth/me");
        const meJSON = await meResponse.json();
        setMe(meJSON);
      } catch {
        setMe(null);
      }
      try {
        const csrfResponse = await api("/auth/csrf");
        const csrfJSON = await csrfResponse.json();
        setCsrfToken(csrfJSON.csrf_token);
      } catch {
        setCsrfToken(null);
      }
      // Signal to the rest of the app that auth checks are complete.
      setInitialized(true);
    }
    initAuth();
  }, []);
  /**
   * Logs in the user with the provided credentials
   * @param {string} username - The user's username
   * @param {string} password - The user's password
   */
  async function login(username, password) {
    // Send login credentials to the server
    await api("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    // Fetch the current user data after successful login
    const meResponse = await api("/auth/me");
    const meJSON = await meResponse.json();
    // Fetch the CSRF token for subsequent write operations
    const csrfResponse = await api("/auth/csrf");
    const csrfJSON = await csrfResponse.json();
    // Update state with user data and CSRF token
    setMe(meJSON);
    setCsrfToken(csrfJSON.csrf_token);
  }
  async function logout() {
    // Send logout request to the server
    try {
      await api("/auth/logout", { method: "POST" });
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      // Clear user data and CSRF token from state
      setMe(null);
      setCsrfToken(null);
    }
  }

  /**
   * Makes an authenticated API request
   * @param {string} path - The API endpoint path
   * @param {Object} options - The fetch options
   * @returns {Promise<Response>} - The API response
   */
  async function request(path, options = {}) {
    // Determine if this is a write operation that requires CSRF protection
    const method = options.method?.toUpperCase() ?? "GET";
    const isWrite = ["POST", "PUT", "DELETE", "PATCH"].includes(method);
    // Include CSRF token in headers for write operations if available
    const headers = {
      ...options.headers,
      ...(isWrite && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    };
    // Delegate to the shared API helper to apply base URL and credentials.
    const response = await api(path, {
      ...options,
      method,
      headers,
    });
    return response;
  }

  return (
    <AuthContext.Provider
      value={{ me, csrfToken, login, request, logout, initialized }}
    >
      {children}
    </AuthContext.Provider>
  );
}
