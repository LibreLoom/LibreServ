// TODO: AuthContext roadmap
//
// 1) Logout — DONE!
// - Add backend endpoint to clear the auth cookie (e.g. POST /auth/logout)
// - Add frontend logout() function:
//   - call /auth/logout
//   - set me = null
//   - set csrfToken = null
//
// 2) Session restore on page refresh (bootstrap)
// - On AuthProvider mount, attempt to restore session from cookie:
//   - GET /auth/me → if OK, set me
//   - GET /auth/csrf → set csrfToken
// - If either request fails, leave state as null (user is logged out)
//
// 3) Handle token expiry / re-login flow
// - Access-cookie-only auth will eventually return 401 (~15 min expiry)
// - For now:
//   - treat any 401 as "logged out"
//   - clear auth state
//   - redirect to login
// - Later:
//   - add refresh-token flow instead of hard logout
import { useState } from "react";
import api from "../lib/api";
import { AuthContext } from "./AuthContextContext";

export function AuthProvider({ children }) {
  // State to store the current user information
  const [me, setMe] = useState(null);
  // State to store the CSRF token for write operations
  const [csrfToken, setCsrfToken] = useState(null);

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
    const isWrite =
      options.method === "POST" ||
      options.method === "PUT" ||
      options.method === "DELETE" ||
      options.method === "PATCH";
    // Include CSRF token in headers for write operations if available
    const headers = {
      ...options.headers,
      ...(isWrite && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    };
    // Make the API request
    const response = await api(path, {
      ...options,
      ...(options.method ? {} : { method: "GET" }),
      headers,
    });
    return response;
  }

  return (
    <AuthContext.Provider value={{ me, csrfToken, login, request, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
