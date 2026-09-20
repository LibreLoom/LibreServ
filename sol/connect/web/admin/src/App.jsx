import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";

const Login = lazy(() => import("./pages/Login.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Accounts = lazy(() => import("./pages/Accounts.jsx"));
const ConnectKeys = lazy(() => import("./pages/ConnectKeys.jsx"));
const Devices = lazy(() => import("./pages/Devices.jsx"));
const Cases = lazy(() => import("./pages/Cases.jsx"));
const Plans = lazy(() => import("./pages/Plans.jsx"));
const Security = lazy(() => import("./pages/Security.jsx"));
const Providers = lazy(() => import("./pages/Providers.jsx"));
const Tunnels = lazy(() => import("./pages/Tunnels.jsx"));

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function Loading() {
  return (
    <div className="min-h-screen bg-primary text-secondary flex items-center justify-center">
      <p className="font-mono text-accent animate-pulse">Loading…</p>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/accounts" element={<ProtectedRoute><Accounts /></ProtectedRoute>} />
        <Route path="/connect-keys" element={<ProtectedRoute><ConnectKeys /></ProtectedRoute>} />
        <Route path="/devices" element={<ProtectedRoute><Devices /></ProtectedRoute>} />
        <Route path="/cases" element={<ProtectedRoute><Cases /></ProtectedRoute>} />
        <Route path="/plans" element={<ProtectedRoute><Plans /></ProtectedRoute>} />
        <Route path="/providers" element={<ProtectedRoute><Providers /></ProtectedRoute>} />
        <Route path="/tunnels" element={<ProtectedRoute><Tunnels /></ProtectedRoute>} />
        <Route path="/security" element={<ProtectedRoute><Security /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
