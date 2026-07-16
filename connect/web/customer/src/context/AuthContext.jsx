import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api, getToken, setToken, clearToken } from "../api/client.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(!!getToken());
  const [device, setDevice] = useState(null);
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (token) => {
    setLoading(true);
    try {
      const res = await api.login(token);
      setToken(res.token);
      setIsAuthenticated(true);
      setDevice({ id: res.device_id, plan_id: res.plan_id, plan_name: res.plan_name });
      return res;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setDevice(null);
  }, []);

  const refreshDevice = useCallback(async () => {
    if (!getToken()) return;
    try {
      const dev = await api.getDevice();
      setDevice(dev);
    } catch {
      clearToken();
      setIsAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      refreshDevice();
    }
  }, [isAuthenticated, refreshDevice]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, device, login, logout, refreshDevice, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
