import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { MainLayout } from './components/layout';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Setup from './pages/Setup';

function App() {
  const [user, setUser] = useState(null);
  const [isSetupComplete, setIsSetupComplete] = useState(true); // Will be fetched from API
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check authentication and setup status
    const checkAuth = async () => {
      try {
        // TODO: Replace with actual API calls
        const savedUser = localStorage.getItem('libreserv-user');
        if (savedUser) {
          setUser(JSON.parse(savedUser));
        }
        
        // Check if setup is complete
        // const setupStatus = await api.getSetupStatus();
        // setIsSetupComplete(setupStatus.complete);
        
      } catch (err) {
        console.error('Auth check failed:', err);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  const handleLogin = (userData) => {
    setUser(userData);
    localStorage.setItem('libreserv-user', JSON.stringify(userData));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('libreserv-user');
    localStorage.removeItem('libreserv-token');
  };

  const handleSetupComplete = (userData) => {
    setIsSetupComplete(true);
    handleLogin(userData);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="font-mono text-lg animate-pulse">Loading...</div>
      </div>
    );
  }

  // Show setup if not complete
  if (!isSetupComplete) {
    return (
      <ThemeProvider>
        <Setup onComplete={handleSetupComplete} />
      </ThemeProvider>
    );
  }

  // Show login if not authenticated
  if (!user) {
    return (
      <ThemeProvider>
        <Login onLogin={handleLogin} />
      </ThemeProvider>
    );
  }

  // Main app
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<MainLayout user={user} systemStatus="operational" />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/users" element={<PlaceholderPage title="Users" />} />
            <Route path="/settings" element={<PlaceholderPage title="Settings" />} />
            <Route path="/support" element={<PlaceholderPage title="Support" />} />
            <Route path="/profile" element={<PlaceholderPage title="Profile" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

// Placeholder component for pages not yet implemented
function PlaceholderPage({ title }) {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <div className="text-center">
        <h1 className="font-mono text-2xl mb-2">{title}</h1>
        <p className="text-[var(--color-accent)]">Coming soon...</p>
      </div>
    </div>
  );
}

export default App;
