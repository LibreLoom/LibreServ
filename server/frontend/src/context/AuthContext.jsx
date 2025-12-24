// TODO: AuthContext roadmap
//
// 1) Logout
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
import { AuthContext } from "./AuthContext";
export function AuthProvider({ children }) {
  const [me, setMe] = useState(null);
  const [csrfToken, setCsrfToken] = useState(null);
  async function login(username, password) {
    await api("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const meResponse = await api("/auth/me");
    const meJSON = await meResponse.json();
    const csrfResponse = await api("/auth/csrf");
    const csrfJSON = await csrfResponse.json();
    setMe(meJSON);
    setCsrfToken(csrfJSON.csrf_token);
  }
  async function request(path, options = {}) {
    const isWrite =
      options.method === "POST" ||
      options.method === "PUT" ||
      options.method === "DELETE" ||
      options.method === "PATCH";
    const headers = {
      ...options.headers,
      ...(isWrite && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    };
    const response = await api(path, {
      ...options,
      ...(options.method ? {} : { method: "GET" }),
      headers,
    });
    return response;
  }
  return (
    <AuthContext.Provider value={{ me, csrfToken, login, request }}>
      {children}
    </AuthContext.Provider>
  );
}
