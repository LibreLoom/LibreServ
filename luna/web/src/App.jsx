import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Navbar from "./components/ui/Navbar";
import DrivesPage from "./pages/DrivesPage";
import FilesPage from "./pages/FilesPage";
import GalleryPage from "./pages/GalleryPage";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import RemotePage from "./pages/RemotePage";
import SharedPage from "./pages/SharedPage";
import SharesPage from "./pages/SharesPage";
import UsersPage from "./pages/UsersPage";
import SetupPage from "./pages/SetupPage";
import NotFoundPage from "./pages/NotFoundPage";
import ProtectionPage from "./pages/ProtectionPage";

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
  return (
    <RequireAuth>
      <div data-slot="app-shell" className="min-h-screen bg-primary text-secondary">
        <Outlet />
        <Navbar />
      </div>
    </RequireAuth>
  );
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
              <Route element={<AppShell />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/drives" element={<DrivesPage />} />
                <Route path="/drives/:id" element={<FilesPage />} />
                <Route path="/gallery" element={<GalleryPage />} />
                <Route path="/settings/users" element={<UsersPage />} />
                <Route path="/settings/shares" element={<SharesPage />} />
                <Route path="/shared" element={<SharedPage />} />
                <Route path="/settings/protect" element={<ProtectionPage />} />
                <Route path="/settings/remote" element={<RemotePage />} />
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
