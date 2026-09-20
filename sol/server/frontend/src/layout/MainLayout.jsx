import { Outlet, useLocation } from "react-router-dom";
import Navbar from "../components/ui/Navbar";
import LoadingBar from "../components/common/LoadingBar";

export default function MainLayout() {
  const location = useLocation();
  return (
    <div className="relative flex flex-col">
      <LoadingBar />
      {/* Skip link keeps keyboard users from tabbing through navigation every time. */}
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {/* Routed page content renders here; navbar stays persistent.
          Keying by pathname gives every navigation a smooth entrance. */}
      <div key={location.pathname} className="grow w-full animate-page-enter">
        <Outlet />
      </div>
      <Navbar />
    </div>
  );
}
