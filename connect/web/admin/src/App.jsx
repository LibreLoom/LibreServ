import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";

const Login = lazy(() => import("./pages/Login.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Devices = lazy(() => import("./pages/Devices.jsx"));
const Cases = lazy(() => import("./pages/Cases.jsx"));
const Plans = lazy(() => import("./pages/Plans.jsx"));
const Models = lazy(() => import("./pages/Models.jsx"));
const Relay = lazy(() => import("./pages/Relay.jsx"));

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function Loading() {
  return (
    <div className="min-h-screen bg-primary text-secondary flex items-center justify-center">
      <p className="font-mono text-accent animate-pulse">Loading...</p>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/devices" element={<ProtectedRoute><Devices /></ProtectedRoute>} />
        <Route path="/cases" element={<ProtectedRoute><Cases /></ProtectedRoute>} />
        <Route path="/plans" element={<ProtectedRoute><Plans /></ProtectedRoute>} />
        <Route path="/models" element={<ProtectedRoute><Models /></ProtectedRoute>} />
        <Route path="/relay" element={<ProtectedRoute><Relay /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
