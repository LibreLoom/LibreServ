import {
  Grid2X2,
  Home,
  Settings,
  Users,
  LifeBuoy,
  Menu,
  X,
} from "lucide-react";
import { PiLineVerticalLight } from "react-icons/pi";
import { NavLink } from "react-router-dom";
import { useState, useEffect } from "react";

const navButtonClasses =
  // Layout
  "flex " +
  // Alignment
  "items-center " +
  // Spacing between elements
  "gap-2 " +
  // Transition effects
  "transition-all " +
  // Horizontal padding
  "px-3 " +
  // Vertical padding
  "py-1.5 " +
  // Rounded corners
  "rounded-pill " +
  // Hover background
  "hover:bg-primary " +
  // Hover text color
  "hover:text-secondary " +
  // Active page background
  "aria-[current=page]:bg-primary " +
  // Active page text color
  "aria-[current=page]:text-secondary " +
  // Hover + active text inversion
  "hover:aria-[current=page]:text-primary " +
  // Hover + active background inversion
  "hover:aria-[current=page]:bg-secondary " +
  // Hover + active outline width
  "hover:aria-[current=page]:outline-2 " +
  // Hover + active outline color
  "hover:aria-[current=page]:outline-primary " +
  // Hover + active outline style
  "hover:aria-[current=page]:outline-solid";
// Divider line between nav links
const dividerClasses = "text-accent";

export default function Navbar() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const handleResize = () => {
      if (window.innerWidth > 1280) {
        setIsMobileMenuOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [isMobileMenuOpen]);
  return (
    <>
      <div className="hidden xl:flex">
        <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 min-w-screen pl-6 pr-6">
          <div className="bg-secondary text-primary rounded-pill px-6 py-3">
            <div className="flex items-center gap-6 text-sm font-sans justify-center">
              <NavLink to="/" className={navButtonClasses}>
                <Home size={18} />
                <span>Dashboard</span>
              </NavLink>

              <PiLineVerticalLight className={dividerClasses} size={36} />

              <NavLink to="/apps" className={navButtonClasses}>
                <Grid2X2 size={18} />
                <span>Apps</span>
              </NavLink>

              <PiLineVerticalLight className={dividerClasses} size={36} />

              <NavLink to="/users" className={navButtonClasses}>
                <Users size={18} />
                <span>Users</span>
              </NavLink>

              <PiLineVerticalLight className={dividerClasses} size={36} />

              <NavLink to="/settings" className={navButtonClasses}>
                <Settings size={18} />
                <span>Settings</span>
              </NavLink>

              <PiLineVerticalLight className={dividerClasses} size={36} />

              <NavLink to="/help" className={navButtonClasses}>
                <LifeBuoy size={18} />
                <span>Help</span>
              </NavLink>
            </div>
          </div>
        </nav>
      </div>
      <button
        className="fixed h-16 w-16 bottom-6 right-6 z-1000 xl:hidden bg-secondary text-primary rounded-pill"
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
      >
        <div className="relative w-full h-full items-center justify-center flex">
          <X
            className={`absolute transition-all duration-300 ease-[cubic-bezier(0.2, 0, 0, 1)] ${isMobileMenuOpen ? "opacity-100 rotate-0 scale-100" : "opacity-0 -rotate-90 scale-50"}`}
            size={36}
          />
          <Menu
            className={`absolute transition-all duration-300 ease-[cubic-bezier(0.2, 0, 0, 1)] ${isMobileMenuOpen ? "opacity-0 rotate-90 scale-50" : "opacity-100 rotate-0 scale-100"}`}
            size={36}
          />
        </div>
      </button>
      <div
        className={`fixed top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 ${isMobileMenuOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        <nav className="flex flex-col w-[50vw] relative bg-secondary text-primary rounded-large-element justify-center">
          <div className="p-2.5 flex flex-col">
            <NavLink to="/" className={navButtonClasses}>
              <Home size={18} />
              <span>Home</span>
            </NavLink>
            <NavLink to="/apps" className={navButtonClasses}>
              <Grid2X2 size={18} />
              <span>Apps</span>
            </NavLink>
            <NavLink to="/users" className={navButtonClasses}>
              <Users size={18} />
              <span>Users</span>
            </NavLink>
            <NavLink to="/settings" className={navButtonClasses}>
              <Settings size={18} />
              <span>Settings</span>
            </NavLink>
            <NavLink to="/help" className={navButtonClasses}>
              <LifeBuoy size={18} />
              <span>Help</span>
            </NavLink>
          </div>
        </nav>
      </div>
    </>
  );
}
