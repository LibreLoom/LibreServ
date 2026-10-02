import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agentation } from "agentation";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from"@libreloom/ui/context/ThemeContext.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import FileSearch from "./components/files/FileSearch";
import Navbar from "./components/ui/Navbar";
import LoadingBar from "@libreloom/ui/components/common/LoadingBar.jsx";
import RequireAdmin from "./components/auth/RequireAdmin";
import useRecentItemsTracker from "./hooks/useRecentItemsTracker";

// One chunk per page: the first paint downloads only the page being opened.
const DrivesPage = lazy(() => import("./pages/DrivesPage"));
const FilesPage = lazy(() => import("./pages/FilesPage"));
const GalleryPage = lazy(() => import("./pages/GalleryPage"));
const SharedPage = lazy(() => import("./pages/SharedPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const PublicSharePage = lazy(() => import("./pages/PublicSharePage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function RequireAuth({ children }) {
  const { user, setup, hasAdmin, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (setup?.setup_completed === false || (!user && hasAdmin === false)) {
    return <Navigate to="/setup" replace />;
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

/** Feeds the dashboard "Recents" card from wherever the user browses. */
function RecentItemsTracker() {
  useRecentItemsTracker();
  return null;
}

/** Authenticated chrome: page content + fixed bottom navbar. */
function AppShell() {
  const location = useLocation();
  return (
    <RequireAuth>
      <div data-slot="app-shell" className="relative flex min-h-screen flex-col surface-primary">
        <RecentItemsTracker />
        <LoadingBar />
        <a href="#main-content" className="skip-link">Skip to main content</a>
        {/* Keying by pathname gives every navigation a smooth entrance. */}
        <div key={location.pathname} className="grow w-full animate-page-enter">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </div>
        <Navbar />
        <FileSearch />
      </div>
    </RequireAuth>
  );
}

function PhotosToGalleryRedirect() {
  const { hash } = useLocation();
  return <Navigate to={{ pathname: "/gallery", hash }} replace />;
}

export default function App() {
  return (
    <ThemeProvider>
      {/* Dev-only annotation toolbar; tree-shaken out of production builds. */}
      {import.meta.env.DEV && <Agentation />}
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <ShortcutsProvider>
            <AuthProvider>
            <Suspense fallback={null}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/s/:token" element={<PublicSharePage />} />
              <Route element={<AppShell />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/drives" element={<DrivesPage />} />
                <Route path="/drives/:id" element={<FilesPage />} />
                <Route path="/gallery" element={<GalleryPage />} />
                <Route path="/shared" element={<SharedPage />} />
                <Route path="/photos" element={<PhotosToGalleryRedirect />} />
                <Route path="/settings/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/remote" element={<Navigate to={{ pathname: "/settings", hash: "external_services" }} replace />} />
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </Suspense>
            <Toaster />
            </AuthProvider>
            </ShortcutsProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
