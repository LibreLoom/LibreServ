import { Outlet } from "react-router-dom";
import Navbar from "../components/common/Navbar";
import LoadingBar from "../components/common/LoadingBar";

export default function MainLayout() {
  return (
    <div className="relative flex flex-col">
      <LoadingBar />
      {/* Skip link keeps keyboard users from tabbing through navigation every time. */}
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {/* Routed page content renders here; navbar stays persistent. */}
      <div className="grow w-full">
        <Outlet />
      </div>
      <Navbar />
    </div>
  );
}
