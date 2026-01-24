import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import LoadingFast from "./pages/LoadingFast";

const MainLayout = lazy(() => import("./layout/MainLayout"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const AppsPage = lazy(() => import("./pages/AppsPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const UserDetailPage = lazy(() => import("./pages/UserDetailPage"));
const AddUserPage = lazy(() => import("./pages/AddUserPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const HelpPage = lazy(() => import("./pages/HelpPage"));
const AppDetailPage = lazy(() => import("./pages/AppDetailPage"));
const Login = lazy(() => import("./pages/Login"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const LorePage = lazy(() => import("./pages/LorePage"));

function RequireAuth({ children }) {
  const { me, initialized } = useAuth();
  if (!initialized)
    return <LoadingFast label="Checking session..." heading="Authenticating" />;
  return me ? children : <Login />;
}

export default function App() {
  return (
    <Suspense fallback={<LoadingFast label="Loading..." heading="LibreServ" />}>
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
        <Route path="/users/create" element={<AddUserPage />} />
        <Route path="/users/:userId" element={<UserDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/lore" element={<LorePage />} />
      </Route>
      {/* Fallback for unknown routes. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </Suspense>
  );
}
