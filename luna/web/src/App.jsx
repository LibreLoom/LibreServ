import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agentation } from "agentation";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from"@libreloom/ui/context/ThemeContext.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { FileOpsProvider, useFileOpsState } from "./context/FileOpsContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider, useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import { OPEN_FILE_SEARCH_EVENT } from "./lib/fileSearch.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import Navbar from "./components/ui/Navbar";
import LoadingBar from "@libreloom/ui/components/common/LoadingBar.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import useRecentItemsTracker from "./hooks/useRecentItemsTracker";
import { perfEndAfterPaint, perfStart } from "./lib/perf.js";
import lazyWithPreload from "./lib/lazyWithPreload.js";
import { whenIdleAndStill } from "./lib/whenStill.js";

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
const FileSearch = lazyWithPreload(() => import("./components/files/FileSearch.jsx"));
const PublicSharePage = lazy(() => import("./pages/PublicSharePage"));
const RecoveryWizardPage = lazy(() => import("./pages/RecoveryWizardPage"));
// Easter eggs, kept out of the first download like the rest of the rare pages.
const LorePage = lazy(() => import("./pages/LorePage"));
const PigeonPage = lazy(() => import("./pages/PigeonPage"));
// Dev only: opens flows that have no button of their own, for the state gallery.
const FormatFlowHarness = import.meta.env.DEV ? lazy(() => import("./dev/flows/FormatFlowHarness.jsx")) : null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const NAV_PAGES = {
  "/": DashboardPage,
  "/photos": PhotosPage,
  "/files": FilesPage,
  "/shared": SharedPage,
  "/settings": SettingsPage,
};

function savesData() {
  return Boolean(/** @type {any} */ (navigator).connection?.saveData);
}

/** @param {string} to */
function preloadNav(to) {
  if (!savesData()) NAV_PAGES[to.split("#")[0]]?.preload().catch(() => {});
}

function RequireAuth({ children }) {
  const { user, setup, hasAdmin, loading } = useAuth();
  if (loading) return null;
  if (setup?.setup_completed === false || (!user && hasAdmin === false)) {
    return <Navigate to="/setup" replace />;
  }
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
    <div key={location.pathname} className="grow w-full">
      <Suspense fallback={<div className="grid min-h-[50dvh] place-items-center"><Spinner /></div>}>
        <div className="motion-safe:animate-route-enter">
          <Outlet />
          <PageRendered />
        </div>
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
function PreloadPages() {
  useEffect(() => {
    if (savesData()) return undefined;
    const pages = Object.values(NAV_PAGES);
    let index = 0;
    let stopped = false;
    let cancel = () => {};
    const next = () => {
      if (stopped || index >= pages.length) return;
      pages[index++].preload()
        .catch(() => {})
        .then(() => {
          if (!stopped && index < pages.length) cancel = whenIdleAndStill(next);
        });
    };
    cancel = whenIdleAndStill(next);
    return () => {
      stopped = true;
      cancel();
    };
  }, []);
  return null;
}

const hasVisibleOps = (/** @type {import("./lib/fileOps/store.js").FileOpsState} */ state) => state.ops.some((op) => op.shown);

/** Keep the first search action available while leaving its UI out of startup. */
function FileSearchSlot() {
  const [request, setRequest] = useState(/** @type {{ focus: HTMLElement | null } | null} */ (null));
  const open = useCallback(() => {
    setRequest({ focus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    haptic("medium");
  }, []);
  useShortcut(["/", "Alt+/"], open, { label: "Search all your files", group: "Search", enabled: !request });
  useEffect(() => {
    if (request) return undefined;
    window.addEventListener(OPEN_FILE_SEARCH_EVENT, open);
    return () => window.removeEventListener(OPEN_FILE_SEARCH_EVENT, open);
  }, [request, open]);

  if (!request) return null;
  return (
    <Suspense fallback={<div className="pointer-events-none fixed inset-0 z-50 grid place-items-center"><Spinner label="Opening search" /></div>}>
      <FileSearch initialRequest={request} />
    </Suspense>
  );
}

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
  return (
    <RequireAuth>
      <div data-slot="app-shell" className="relative flex min-h-screen flex-col surface-primary">
        <PreloadPages />
        <RecentItemsTracker />
        <LoadingBar />
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <PageOutlet />
        <FileOpsDockSlot />
        <Navbar onNavigationIntent={preloadNav} />
        <FileSearchSlot />
      </div>
    </RequireAuth>
  );
}

/**
 * /login fetches the Dashboard's code while the user types (W3). Only that
 * page: the rest would be decoding on a slow box right as sign-in finishes.
 */
function LoginRoute() {
  useEffect(() => {
    preloadNav("/");
  }, []);
  return <LoginPage />;
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
                <Route path="/lore" element={<LorePage />} />
                <Route path="/pigeon" element={<PigeonPage />} />
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
