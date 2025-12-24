// TODO: Implement AuthContext
import { useState } from "react";
import api from "../lib/api";
import { AuthContext } from "./authContext";
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
  return (
    <AuthContext.Provider value={{ me, csrfToken, login }}>
      {children}
    </AuthContext.Provider>
  );
}
