import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSetupComplete, setIsSetupComplete] = useState(true);

  // Check auth status on mount
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    setIsLoading(true);
    try {
      // DEV MODE: Auto-login for development
      if (import.meta.env.DEV) {
        setUser({
          id: 'dev-admin',
          username: 'admin',
          email: 'admin@localhost',
          role: 'admin',
          permissions: ['*'], // Admin has all permissions
        });
        setIsSetupComplete(true);
        return;
      }

      // TODO: Replace with actual API call
      const token = localStorage.getItem('libreserv-token');
      if (token) {
        // Validate token with API
        setUser({
          id: '1',
          username: 'admin',
          email: 'admin@example.com',
          role: 'admin',
          permissions: ['*'],
        });
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = useCallback(async (username, password) => {
    try {
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const userData = {
        id: '1',
        username,
        email: `${username}@example.com`,
        role: 'admin',
        permissions: ['*'],
      };
      
      localStorage.setItem('libreserv-token', 'mock-token');
      setUser(userData);
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Invalid credentials' };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('libreserv-token');
    setUser(null);
  }, []);

  const completeSetup = useCallback(async (setupData) => {
    try {
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      setIsSetupComplete(true);
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Setup failed' };
    }
  }, []);

  // Check if user has permission for an action
  const hasPermission = useCallback((permission, appId = null) => {
    if (!user) return false;
    if (user.permissions.includes('*')) return true; // Admin
    
    if (appId) {
      return user.permissions.includes(`${appId}:${permission}`) ||
             user.permissions.includes(`${appId}:*`);
    }
    
    return user.permissions.includes(permission);
  }, [user]);

  const value = {
    user,
    isLoading,
    isAuthenticated: !!user,
    isSetupComplete,
    login,
    logout,
    completeSetup,
    hasPermission,
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
