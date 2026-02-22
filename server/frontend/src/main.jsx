import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "goey-toast/styles.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { setupGlobalErrorHandlers } from "./utils/errorReporting";
import { GoeyToaster } from "goey-toast";

setupGlobalErrorHandlers();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <GoeyToaster position="top-right" spring={false} />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
