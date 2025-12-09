import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NavigationProvider } from './context/NavigationContext';

import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Apps from './pages/Apps';
import AppDetail from './pages/AppDetail';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Profile from './pages/Profile';
import Support from './pages/Support';
import Network from './pages/Network';
import SetupWizard from './pages/SetupWizard';

// Placeholder for pages not yet built
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

// Loading screen
function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-primary)]">
      <div className="text-center">
        <div className="w-10 h-10 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="font-mono text-[var(--color-accent)]">Loading LibreServ...</p>
      </div>
    </div>
  );
}

// Login page (simple for now)
function LoginPage() {
  const { login } = useAuth();
  
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-primary)] p-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="font-mono text-3xl mb-8">LibreServ</h1>
        <button
          onClick={() => login('admin', 'password')}
          className="
            w-full px-6 py-3
            bg-[var(--color-secondary)] text-[var(--color-primary)]
            border-2 border-[var(--color-secondary)]
            rounded-full font-mono
            hover:bg-transparent hover:text-[var(--color-secondary)]
            transition-all duration-200
          "
        >
          Sign In
        </button>
      </div>
    </div>
  );
}

// Routes with auth
function AppRoutes() {
  const { isLoading, isAuthenticated, isSetupComplete } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!isSetupComplete) {
    return <SetupWizard />;
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/apps" element={<Apps />} />
          <Route path="/apps/:appId" element={<AppDetail />} />
          <Route path="/users" element={<Users />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/network" element={<Network />} />
          <Route path="/support" element={<Support />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <NavigationProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </NavigationProvider>
    </ThemeProvider>
  );
}
