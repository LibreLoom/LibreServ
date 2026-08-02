import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";

const Login = lazy(() => import("./pages/Login.jsx"));
const Register = lazy(() => import("./pages/Register.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Plans = lazy(() => import("./pages/Plans.jsx"));
const Domains = lazy(() => import("./pages/Domains.jsx"));
const Onboarding = lazy(() => import("./pages/Onboarding.jsx"));
const Usage = lazy(() => import("./pages/Usage.jsx"));
const Billing = lazy(() => import("./pages/Billing.jsx"));
const Security = lazy(() => import("./pages/Security.jsx"));
const VerifyEmail = lazy(() => import("./pages/VerifyEmail.jsx"));

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
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
        <Route path="/login" element={<Login />} />
        <Route path="/onboarding" element={<Onboarding />} />
        {/* Already-signed-in users have no business on the signup form —
            the "username taken" errors were them bumping into their own
            account. Send them to the dashboard instead. */}
        <Route
          path="/register"
          element={isAuthenticated ? <Navigate to="/" replace /> : <Register />}
        />
        <Route path="/verify-email" element={<VerifyEmail />} />
		<Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
		<Route path="/plans" element={<ProtectedRoute><Plans /></ProtectedRoute>} />
		<Route path="/domains" element={<ProtectedRoute><Domains /></ProtectedRoute>} />
		<Route path="/usage" element={<ProtectedRoute><Usage /></ProtectedRoute>} />
		<Route path="/billing" element={<ProtectedRoute><Billing /></ProtectedRoute>} />
		<Route path="/security" element={<ProtectedRoute><Security /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
