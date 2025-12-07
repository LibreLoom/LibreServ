import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as authApi from '../api/auth';
import * as setupApi from '../api/setup';

const AuthContext = createContext(null);

// Dev mode mock user for local development
const DEV_USER = {
  id: 'dev-admin',
  username: 'admin',
  email: 'admin@localhost',
  role: 'admin',
  permissions: ['*'],
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSetupComplete, setIsSetupComplete] = useState(true);
  const [error, setError] = useState(null);

  // Check auth status on mount
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      // DEV MODE: Auto-login for development when no backend
      if (import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK_AUTH === 'true') {
        setUser(DEV_USER);
        setIsSetupComplete(true);
        return;
      }

      // Check setup status first
      try {
        const setupStatus = await setupApi.getSetupStatus();
        setIsSetupComplete(setupStatus.complete !== false);
        
        if (!setupStatus.complete) {
          // Setup not complete, no need to check auth
          return;
        }
      } catch (err) {
        // If setup endpoint fails, assume setup is complete
        // (might be in dev mode or endpoint not available)
        console.warn('Setup status check failed:', err);
      }

      // Validate existing auth
      const validatedUser = await authApi.validateAuth();
      if (validatedUser) {
        // Add permissions array if not present
        setUser({
          ...validatedUser,
          permissions: validatedUser.permissions || (validatedUser.role === 'admin' ? ['*'] : []),
        });
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error('Auth check failed:', err);
      setError(err.message);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = useCallback(async (username, password) => {
    setError(null);
    
    try {
      const response = await authApi.login(username, password);
      
      // Extract user from response
      const userData = {
        ...response.user,
        permissions: response.user.permissions || (response.user.role === 'admin' ? ['*'] : []),
      };
      
      setUser(userData);
      return { success: true, user: userData };
    } catch (err) {
      const errorMessage = err.data?.error || err.message || 'Login failed';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  }, []);

  const logout = useCallback(() => {
    authApi.logout();
    setUser(null);
    setError(null);
  }, []);

  const register = useCallback(async (username, password, email) => {
    setError(null);
    
    try {
      const response = await authApi.register(username, password, email);
      return { success: true, user: response.user };
    } catch (err) {
      const errorMessage = err.data?.error || err.message || 'Registration failed';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  }, []);

  const changePassword = useCallback(async (oldPassword, newPassword) => {
    setError(null);
    
    try {
      await authApi.changePassword(oldPassword, newPassword);
      return { success: true };
    } catch (err) {
      const errorMessage = err.data?.error || err.message || 'Password change failed';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  }, []);

  const completeSetup = useCallback(async (setupData) => {
    setError(null);
    
    try {
      await setupApi.completeSetup(setupData);
      setIsSetupComplete(true);
      
      // Auto-login after setup
      if (setupData.username && setupData.password) {
        await login(setupData.username, setupData.password);
      }
      
      return { success: true };
    } catch (err) {
      const errorMessage = err.data?.error || err.message || 'Setup failed';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  }, [login]);

  // Check if user has permission for an action
  const hasPermission = useCallback((permission, appId = null) => {
    if (!user) return false;
    if (user.permissions?.includes('*')) return true; // Admin has all permissions
    
    if (appId) {
      // Check app-specific permissions
      return user.permissions?.includes(`${appId}:${permission}`) ||
             user.permissions?.includes(`${appId}:*`);
    }
    
    return user.permissions?.includes(permission);
  }, [user]);

  // Clear any existing error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value = {
    user,
    isLoading,
    isAuthenticated: !!user,
    isSetupComplete,
    error,
    login,
    logout,
    register,
    changePassword,
    completeSetup,
    hasPermission,
    clearError,
    refreshAuth: checkAuth,
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
