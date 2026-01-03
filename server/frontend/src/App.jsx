import MainLayout from "./layout/MainLayout";
import DashboardPage from "./pages/DashboardPage";
import AppsPage from "./pages/AppsPage";
import UsersPage from "./pages/UsersPage";
import UserDetailPage from "./pages/UserDetailPage";
import SettingsPage from "./pages/SettingsPage";
import HelpPage from "./pages/HelpPage";
import AppDetailPage from "./pages/AppDetailPage";
import Login from "./pages/Login";
import LoadingFast from "./pages/LoadingFast";
import NotFoundPage from "./pages/NotFoundPage";
import LorePage from "./pages/LorePage";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";

function RequireAuth({ children }) {
  const { me, initialized } = useAuth();
  // Block route rendering until we know whether a session exists.
  if (!initialized)
    return <LoadingFast label="Checking session..." heading="Authenticating" />;
  // If no user is loaded, keep the user on the login screen.
  return me ? children : <Login />;
}

export default function App() {
  return (
    <Routes>
      {/* App shell routes: gated by auth to keep public access minimal. */}
      {/* Wrap app routes so auth and layout are applied consistently. */}
      <Route
        element={
          <RequireAuth>
            <MainLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/apps" element={<AppsPage />} />
        <Route path="/apps/:appName" element={<AppDetailPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/users/:userId" element={<UserDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/lore" element={<LorePage />} />
      </Route>
      {/* Fallback for unknown routes. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
