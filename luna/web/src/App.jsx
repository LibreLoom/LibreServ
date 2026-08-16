import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import DrivesPage from "./pages/DrivesPage";
import FilesPage from "./pages/FilesPage";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import SharesPage from "./pages/SharesPage";
import UsersPage from "./pages/UsersPage";
import SetupPage from "./pages/SetupPage";
import NotFoundPage from "./pages/NotFoundPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/" element={<RequireAuth><LandingPage /></RequireAuth>} />
              <Route path="/drives" element={<RequireAuth><DrivesPage /></RequireAuth>} />
              <Route path="/drives/:id" element={<RequireAuth><FilesPage /></RequireAuth>} />
              <Route path="/settings/users" element={<RequireAuth><UsersPage /></RequireAuth>} />
              <Route path="/settings/shares" element={<RequireAuth><SharesPage /></RequireAuth>} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
