import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MainLayout } from './components/layout';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Users from './pages/Users';
import Profile from './pages/Profile';
import AppDetail from './pages/AppDetail';
import Login from './pages/Login';
import Setup from './pages/Setup';

// Loading spinner component
function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="font-mono text-[var(--color-accent)]">Loading...</p>
      </div>
    </div>
  );
}

// App routes with auth logic
function AppRoutes() {
  const { user, isLoading, isSetupComplete, isAuthenticated, login, logout, completeSetup } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  // Show setup if not complete
  if (!isSetupComplete) {
    return <Setup onComplete={completeSetup} />;
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return <Login onLogin={login} />;
  }

  // Main app
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<MainLayout user={user} systemStatus="operational" onLogout={logout} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/users" element={<Users />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/support" element={<PlaceholderPage title="Support" />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/apps/:appId" element={<AppDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
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
