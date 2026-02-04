import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Global styles and tokens live here so every route shares them.
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { setupGlobalErrorHandlers } from "./utils/errorReporting";

// Set up global error handlers for unhandled promise rejections and window errors
setupGlobalErrorHandlers();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {/* Router at the top so layout and auth flows can use route-aware components. */}
    <BrowserRouter>
      {/* Auth provider supplies session state + authenticated request helper. */}
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
