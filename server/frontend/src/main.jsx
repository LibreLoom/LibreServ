import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// @ts-ignore - Vite handles CSS imports
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupGlobalErrorHandlers } from "./utils/errorReporting";
import Toaster from "./components/common/Toaster";
import { SessionExpiredProvider } from "./components/common/SessionExpiredProvider";

setupGlobalErrorHandlers();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThemeProvider>
            <ToastProvider>
              <SessionExpiredProvider>
                <App />
                <Toaster />
              </SessionExpiredProvider>
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
