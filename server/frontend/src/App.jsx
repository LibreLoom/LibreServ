import "./App.css";
import MainLayout from "./layout/MainLayout";
import DashboardPage from "./pages/DashboardPage";
import AppsPage from "./pages/AppsPage";
import UsersPage from "./pages/UsersPage";
import SettingsPage from "./pages/SettingsPage";
import HelpPage from "./pages/HelpPage";
import Login from "./pages/Login";
import LoadingFast from "./pages/LoadingFast";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";

function RequireAuth({ children }) {
  const { me, initialized } = useAuth();
  if (!initialized) return <LoadingFast label="Checking session..." />;
  return me ? children : <Login />;
}

export default function App() {
  return (
    <Routes>
      <Route
        element={
          <RequireAuth>
            <MainLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/apps" element={<AppsPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/help" element={<HelpPage />} />
      </Route>
    </Routes>
  );
}
