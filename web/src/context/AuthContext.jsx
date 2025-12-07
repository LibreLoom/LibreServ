import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi, ApiError } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSetupComplete, setIsSetupComplete] = useState(true);
  const [error, setError] = useState(null);

  // Check authentication status on mount
  useEffect(() => {
    // DEV MODE: Skip auth check, set mock user
    if (import.meta.env.DEV) {
      setUser({ username: 'admin', role: 'admin' });
      setIsSetupComplete(true);
      setIsLoading(false);
      return;
    }
    checkAuth();
  }, []);

  const checkAuth = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      // First check if setup is complete
      const setupStatus = await authApi.getSetupStatus();
      setIsSetupComplete(setupStatus.setup_complete);

      if (!setupStatus.setup_complete) {
        setIsLoading(false);
        return;
      }

      // Check if we have a token
      const token = localStorage.getItem('libreserv-token');
      if (!token) {
        setIsLoading(false);
        return;
      }

      // Validate token by getting current user
      const userData = await authApi.me();
      setUser(userData);
    } catch (err) {
      // If unauthorized, clear token
      if (err instanceof ApiError && err.status === 401) {
        authApi.logout();
      }
      // Setup endpoint might not exist yet, assume complete
      if (err instanceof ApiError && err.status === 404) {
        setIsSetupComplete(true);
      }
      console.error('Auth check failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const login = useCallback(async (username, password) => {
    setError(null);
    try {
      const response = await authApi.login(username, password);
      
      // Store refresh token
      if (response.refresh_token) {
        localStorage.setItem('libreserv-refresh-token', response.refresh_token);
      }
      
      // Get user data
      const userData = await authApi.me();
      setUser(userData);
      
      return userData;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Login failed';
      setError(message);
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    authApi.logout();
    setUser(null);
  }, []);

  const completeSetup = useCallback(async (setupData) => {
    setError(null);
    try {
      const response = await authApi.completeSetup(setupData);
      
      // Store refresh token
      if (response.refresh_token) {
        localStorage.setItem('libreserv-refresh-token', response.refresh_token);
      }
      
      setIsSetupComplete(true);
      
      // Get user data
      const userData = await authApi.me();
      setUser(userData);
      
      return userData;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Setup failed';
      setError(message);
      throw err;
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    const refreshToken = localStorage.getItem('libreserv-refresh-token');
    if (!refreshToken) {
      logout();
      return false;
    }

    try {
      const response = await authApi.refreshToken(refreshToken);
      if (response.refresh_token) {
        localStorage.setItem('libreserv-refresh-token', response.refresh_token);
      }
      return true;
    } catch (err) {
      logout();
      return false;
    }
  }, [logout]);

  const value = {
    user,
    isLoading,
    isSetupComplete,
    isAuthenticated: !!user,
    error,
    login,
    logout,
    completeSetup,
    refreshAuth,
    checkAuth,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
