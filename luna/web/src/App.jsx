import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Navbar from "./components/ui/Navbar";
import LoadingBar from "./components/common/LoadingBar";
import DrivesPage from "./pages/DrivesPage";
import FilesPage from "./pages/FilesPage";
import GalleryPage from "./pages/GalleryPage";
import PublicAlbumPage from "./pages/PublicAlbumPage";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import UsersPage from "./pages/UsersPage";
import SetupPage from "./pages/SetupPage";
import NotFoundPage from "./pages/NotFoundPage";
import SettingsPage from "./pages/SettingsPage";
import PublicSharePage from "./pages/PublicSharePage";
import RequireAdmin from "./components/auth/RequireAdmin";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function RequireAuth({ children }) {
  const { user, setup, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  // Not set up yet — the wizard is the only app there is.
  if (setup && setup.setup_completed === false) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

/** Authenticated chrome: page content + fixed bottom navbar. */
function AppShell() {
  const location = useLocation();
  return (
    <RequireAuth>
      <div data-slot="app-shell" className="relative flex min-h-screen flex-col bg-primary text-secondary">
        <LoadingBar />
        <a href="#main-content" className="skip-link">Skip to main content</a>
        {/* Keying by pathname gives every navigation a smooth entrance. */}
        <div key={location.pathname} className="grow w-full animate-page-enter">
          <Outlet />
        </div>
        <Navbar />
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
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/s/:token" element={<PublicSharePage />} />
              <Route path="/a/:token" element={<PublicAlbumPage />} />
              <Route element={<AppShell />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/drives" element={<DrivesPage />} />
                <Route path="/drives/:id" element={<FilesPage />} />
                <Route path="/gallery" element={<GalleryPage />} />
                <Route path="/photos" element={<PhotosToGalleryRedirect />} />
                <Route path="/settings/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/remote" element={<Navigate to={{ pathname: "/settings", hash: "remote" }} replace />} />
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
