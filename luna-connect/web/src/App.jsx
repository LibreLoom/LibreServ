import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import { useAdminAuth } from "./context/AdminAuthContext.jsx";

const Login = lazy(() => import("./pages/Login.jsx"));
const LunaPage = lazy(() => import("./pages/LunaPage.jsx"));
const BackupsPage = lazy(() => import("./pages/BackupsPage.jsx"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage.jsx"));
const AdminTokensPage = lazy(() => import("./pages/AdminTokensPage.jsx"));
const AdminLogin = lazy(() => import("./pages/AdminLogin.jsx"));
const AdminDashboardPage = lazy(() => import("./pages/AdminDashboardPage.jsx"));
const AdminDevicesPage = lazy(() => import("./pages/AdminDevicesPage.jsx"));
const AdminAccountsPage = lazy(() => import("./pages/AdminAccountsPage.jsx"));
const AdminSecurityPage = lazy(() => import("./pages/AdminSecurityPage.jsx"));

function Protected({ children }) {
  const { isAuthenticated, ready } = useAuth();
  if (!ready) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <p className="font-mono text-muted-foreground animate-pulse">Loading...</p>
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function AdminProtected({ children }) {
  const { isAuthenticated, ready } = useAdminAuth();
  if (!ready) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <p className="font-mono text-muted-foreground animate-pulse">Loading...</p>
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/admin/login" replace />;
  return children;
}

function Loading() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <p className="font-mono text-muted-foreground animate-pulse">Loading...</p>
    </div>
  );
}

export default function App() {
  const { isAuthenticated, ready } = useAuth();
  const { isAuthenticated: adminAuthed } = useAdminAuth();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/register" element={<OnboardingPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route
          path="/"
          element={
            !ready ? <Loading /> : isAuthenticated ? <LunaPage /> : <Navigate to="/onboarding" replace />
          }
        />
        <Route path="/backups" element={<Protected><BackupsPage /></Protected>} />
        <Route path="/admin/login" element={adminAuthed ? <Navigate to="/admin" replace /> : <AdminLogin />} />
        <Route path="/admin" element={<AdminProtected><AdminDashboardPage /></AdminProtected>} />
        <Route path="/admin/devices" element={<AdminProtected><AdminDevicesPage /></AdminProtected>} />
        <Route path="/admin/tokens" element={<AdminProtected><AdminTokensPage /></AdminProtected>} />
        <Route path="/admin/accounts" element={<AdminProtected><AdminAccountsPage /></AdminProtected>} />
        <Route path="/admin/security" element={<AdminProtected><AdminSecurityPage /></AdminProtected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export { BackupsTab } from "./pages/BackupsPage.jsx";
