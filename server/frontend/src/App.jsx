import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import LoadingFast from "./pages/LoadingFast";
import ErrorBoundary from "./components/common/ErrorBoundary";

const MainLayout = lazy(() => import("./layout/MainLayout"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const AppsPage = lazy(() => import("./pages/AppsPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const UserDetailPage = lazy(() => import("./pages/UserDetailPage"));
const AddUserPage = lazy(() => import("./pages/AddUserPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

const HelpPage = lazy(() => import("./pages/HelpPage"));
const AppDetailPage = lazy(() => import("./pages/AppDetailPage"));
const AppInstallPage = lazy(() => import("./pages/AppInstallPage"));
const Login = lazy(() => import("./pages/Login"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const LorePage = lazy(() => import("./pages/LorePage"));
const ErrorBoundaryDemo = lazy(() => import("./pages/ErrorBoundaryDemo"));
const ErrorDisplayDemo = lazy(() => import("./pages/ErrorDisplayDemo"));

function RequireAuth({ children }) {
  const { me, initialized } = useAuth();
  if (!initialized) return <LoadingFast label="Checking authentication..." />;
  return me ? children : <Login />;
}

// Wrapper for data-heavy pages with error boundary
function DataPage({ children }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingFast />}>
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
            <Route
              path="/"
              element={
                <DataPage>
                  <DashboardPage />
                </DataPage>
              }
            />
            <Route
              path="/apps"
              element={
                <DataPage>
                  <AppsPage />
                </DataPage>
              }
            />
            <Route
              path="/apps/:instanceId"
              element={
                <DataPage>
                  <AppDetailPage />
                </DataPage>
              }
            />
            <Route
              path="/apps/install/:appId"
              element={
                <DataPage>
                  <AppInstallPage />
                </DataPage>
              }
            />
            <Route
              path="/users"
              element={
                <DataPage>
                  <UsersPage />
                </DataPage>
              }
            />
            <Route
              path="/users/create"
              element={
                <DataPage>
                  <AddUserPage />
                </DataPage>
              }
            />
            <Route
              path="/users/:userId"
              element={
                <DataPage>
                  <UserDetailPage />
                </DataPage>
              }
            />
		<Route
			path="/settings"
			element={
				<DataPage>
					<SettingsPage />
				</DataPage>
			}
/>
            <Route path="/help" element={<HelpPage />} />
            <Route path="/lore" element={<LorePage />} />
<Route path="/demo/error-boundary" element={<ErrorBoundaryDemo />} />
          <Route path="/demo/error-display" element={<ErrorDisplayDemo />} />
          </Route>
          {/* Public routes outside auth requirement */}
          <Route path="/setup" element={<SetupPage />} />
          {/* Fallback for unknown routes. */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
