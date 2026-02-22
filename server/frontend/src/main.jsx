import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "goey-toast/styles.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { setupGlobalErrorHandlers } from "./utils/errorReporting";
import { GoeyToaster } from "goey-toast";

setupGlobalErrorHandlers();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <App />
          <GoeyToaster position="top-right" spring={false} />
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
