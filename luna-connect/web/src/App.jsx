import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";

const Login = lazy(() => import("./pages/Login.jsx"));
const Register = lazy(() => import("./pages/Register.jsx"));
const LunaPage = lazy(() => import("./pages/LunaPage.jsx"));
const BackupsPage = lazy(() => import("./pages/BackupsPage.jsx"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage.jsx"));
const AdminTokensPage = lazy(() => import("./pages/AdminTokensPage.jsx"));

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

function Loading() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <p className="font-mono text-muted-foreground animate-pulse">Loading...</p>
    </div>
  );
}

export default function App() {
  const { isAuthenticated } = useAuth();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/register" element={isAuthenticated ? <Navigate to="/" replace /> : <Register />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/" element={<Protected><LunaPage /></Protected>} />
        <Route path="/backups" element={<Protected><BackupsPage /></Protected>} />
        <Route path="/admin/tokens" element={<Protected><AdminTokensPage /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export { BackupsTab } from "./pages/BackupsPage.jsx";
