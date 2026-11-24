import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agentation } from "agentation";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from"@libreloom/ui/context/ThemeContext.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { FileOpsProvider, useFileOpsState } from "./context/FileOpsContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import FileSearch from "./components/files/FileSearch";
import { visibleOps } from "./lib/fileOps/selectors.js";
import Navbar from "./components/ui/Navbar";
import LoadingBar from "@libreloom/ui/components/common/LoadingBar.jsx";
import useRecentItemsTracker from "./hooks/useRecentItemsTracker";
import { perfEndAfterPaint, perfStart } from "./lib/perf.js";
import lazyWithPreload from "./lib/lazyWithPreload.js";

// One chunk per page: the first paint downloads only the page being opened.
// usePreloadPages fetches the rest once the app is idle, and a preloaded page
// then renders without a blank wait (see lazyWithPreload).
const FilesPage = lazyWithPreload(() => import("./pages/FilesPage"));
const FilePage = lazyWithPreload(() => import("./pages/FilePage"));
const PhotosPage = lazyWithPreload(() => import("./pages/PhotosPage"));
const SharedPage = lazyWithPreload(() => import("./pages/SharedPage"));
const DashboardPage = lazyWithPreload(() => import("./pages/DashboardPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const SettingsPage = lazyWithPreload(() => import("./pages/SettingsPage"));
// The file task card and its animation library stay out of the first download:
// most page loads never start a file operation.
const FileOpsDock = lazyWithPreload(() => import("./components/files/fileOps/FileOpsDock.jsx"));
const PublicSharePage = lazy(() => import("./pages/PublicSharePage"));
const RecoveryWizardPage = lazy(() => import("./pages/RecoveryWizardPage"));
// Dev only: opens flows that have no button of their own, for the state gallery.
const FormatFlowHarness = import.meta.env.DEV ? lazy(() => import("./dev/flows/FormatFlowHarness.jsx")) : null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

/** Shown while Luna answers none of the startup requests (e.g. after an update). */
function LunaUnreachableNotice() {
  return (
    <main
      data-slot="luna-unreachable"
      className="fixed inset-0 grid place-items-center surface-primary px-4"
      id="main-content"
      tabIndex={-1}
    >
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <div className="w-full max-w-lg">
        <PageNotice variant="info" surface="secondary">
          <p className="text-primary font-mono text-xl font-normal text-center mb-2">Luna</p>
          <p className="text-primary text-sm text-center">
            Can't reach Luna right now; it may be restarting after an update. We'll keep trying.
          </p>
        </PageNotice>
      </div>
    </main>
  );
}

function RequireAuth({ children }) {
  const { user, setup, hasAdmin, loading, unreachable } = useAuth();
  if (loading) return null;
  if (setup?.setup_completed === false || (!user && hasAdmin === false)) {
    return <Navigate to="/setup" replace />;
  }
  // Luna is restarting after an update: say so instead of showing a sign-in
  // form that cannot work yet. AuthContext polls quietly and swaps the real
  // page back in once Luna answers, keeping the URL and session intact.
  if (!user && unreachable) return <LunaUnreachableNotice />;
  // Sign-in shows up in place, keeping the URL on the page you were on. When a
  // session dies mid-use (password changed, signed out elsewhere) every open
  // tab lands on the sign-in form together, and each returns to its own page
  // after signing in — instead of every tab being dragged to /login.
  if (!user) return <LoginPage />;
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
  // W16 (luna/perf): a route change starts the timer; PageRendered ends it.
  const firstPath = useRef(location.pathname);
  useLayoutEffect(() => {
    if (location.pathname === firstPath.current) return;
    firstPath.current = null;
    perfStart("W16", { fromInput: true, keep: true });
  }, [location.pathname]);
  return (
    <div key={location.pathname} className="grow w-full animate-page-enter">
      <Suspense fallback={null}>
        <Outlet />
        <PageRendered />
      </Suspense>
    </div>
  );
}

/**
 * Mounts in the same Suspense boundary as the page, so its effect runs once
 * the (lazy) page has committed: the end of W16.
 */
function PageRendered() {
  useEffect(() => {
    perfEndAfterPaint("W16");
  }, []);
  return null;
}

/**
 * Once the first page is up and the browser is idle, fetch the other pages'
 * code so a tap in the navbar opens them without a blank wait. Skipped on
 * Data Saver.
 */
function usePreloadPages() {
  useEffect(() => {
    if (/** @type {any} */ (navigator).connection?.saveData) return undefined;
    // Navbar pages first. FilePage last: it brings the file viewer, which
    // warms the ~650 kB text editor. One page at a time, each after the last
    // has landed: loading them all at once kept the CPU busy parsing exactly
    // when someone tapped Photos a moment after the Dashboard (W7).
    const loaders = [DashboardPage, PhotosPage, FilesPage, SharedPage, SettingsPage, FileOpsDock, FilePage].map((page) => page.preload);
    const idle = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 4000 })
      : (fn) => window.setTimeout(fn, 1500);
    const cancel = window.cancelIdleCallback || window.clearTimeout;
    let i = 0;
    let handle = 0;
    let stopped = false;
    const next = () => {
      if (stopped || i >= loaders.length) return;
      loaders[i++]()
        .catch(() => {})
        .then(() => {
          if (!stopped) handle = idle(next);
        });
    };
    handle = idle(next);
    return () => {
      stopped = true;
      cancel(handle);
    };
  }, []);
}

const hasVisibleOps = (/** @type {any} */ state) => visibleOps(state).length > 0;

/**
 * Mounts the file task card the first time there is something to show, then
 * keeps it mounted: the card animates its own exit, which needs it to stay.
 */
function FileOpsDockSlot() {
  const visible = useFileOpsState(hasVisibleOps);
  const [wanted, setWanted] = useState(false);
  if (visible && !wanted) setWanted(true);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <FileOpsDock />
    </Suspense>
  );
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
        <FileOpsDockSlot />
        <Navbar />
        <FileSearch />
      </div>
    </RequireAuth>
  );
}

/**
 * /login fetches the Dashboard's code while the user types (W3). Only that
 * page: the rest would be decoding on a slow box right as sign-in finishes.
 */
function LoginRoute() {
  const { unreachable } = useAuth();
  useEffect(() => {
    if (/** @type {any} */ (navigator).connection?.saveData) return;
    DashboardPage.preload().catch(() => {});
  }, []);
  return <LoginPage unreachable={unreachable} />;
}

function GalleryToPhotosRedirect() {
  const { hash } = useLocation();
  return <Navigate to={{ pathname: "/photos", hash }} replace />;
}

export default function App() {
  return (
    <ThemeProvider>
      {/* Dev-only annotation toolbar; tree-shaken out of production builds. */}
      {import.meta.env.DEV && <Agentation />}
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <FileOpsProvider>
            <ShortcutsProvider>
            <AuthProvider>
            <Suspense fallback={null}>
            <Routes>
              <Route path="/login" element={<LoginRoute />} />
              <Route path="/recover" element={<RecoveryWizardPage />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/s/:token" element={<PublicSharePage />} />
              <Route element={<AppShell />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/files" element={<FilesPage />} />
                <Route path="/files/:id" element={<FilePage />} />
                <Route path="/photos" element={<PhotosPage />} />
                <Route path="/shared" element={<SharedPage />} />
                <Route path="/gallery" element={<GalleryToPhotosRedirect />} />
                <Route path="/settings" element={<SettingsPage />} />
                {FormatFlowHarness && <Route path="/__flow/format" element={<FormatFlowHarness />} />}
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </Suspense>
            <Toaster />
            </AuthProvider>
            </ShortcutsProvider>
            </FileOpsProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
