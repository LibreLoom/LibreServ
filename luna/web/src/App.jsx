import { lazy, Suspense, useEffect } from "react";
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
const loadDrivesPage = () => import("./pages/DrivesPage");
const loadFilesPage = () => import("./pages/FilesPage");
const loadGalleryPage = () => import("./pages/GalleryPage");
const loadSharedPage = () => import("./pages/SharedPage");
const loadDashboardPage = () => import("./pages/DashboardPage");
const loadSettingsPage = () => import("./pages/SettingsPage");
const DrivesPage = lazy(loadDrivesPage);
const FilesPage = lazy(loadFilesPage);
const GalleryPage = lazy(loadGalleryPage);
const SharedPage = lazy(loadSharedPage);
const DashboardPage = lazy(loadDashboardPage);
const LoginPage = lazy(() => import("./pages/LoginPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const SettingsPage = lazy(loadSettingsPage);
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

/**
 * The routed page. Keying by pathname gives every navigation a smooth
 * entrance. It alone reads the location, so the navbar and search around it
 * don't re-render on every folder click (which only changes the query string).
 */
function PageOutlet() {
  const location = useLocation();
  return (
    <div key={location.pathname} className="grow w-full animate-page-enter">
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </div>
  );
}

/**
 * Once the first page is up and the browser is idle, fetch the other pages'
 * code so a tap in the navbar opens them without a blank wait. Skipped on
 * Data Saver.
 */
function usePreloadPages() {
  useEffect(() => {
    if (/** @type {any} */ (navigator).connection?.saveData) return undefined;
    const loaders = [loadFilesPage, loadDrivesPage, loadGalleryPage, loadSharedPage, loadDashboardPage, loadSettingsPage];
    const idle = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 4000 })
      : (fn) => window.setTimeout(fn, 1500);
    const cancel = window.cancelIdleCallback || window.clearTimeout;
    let i = 0;
    let handle = 0;
    const next = () => {
      if (i >= loaders.length) return;
      loaders[i++]().catch(() => {});
      handle = idle(next);
    };
    handle = idle(next);
    return () => cancel(handle);
  }, []);
}

/** Authenticated chrome: page content + fixed bottom navbar. */
function AppShell() {
  usePreloadPages();
  return (
    <RequireAuth>
      <div data-slot="app-shell" className="relative flex min-h-screen flex-col surface-primary">
        <RecentItemsTracker />
        <LoadingBar />
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <PageOutlet />
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
