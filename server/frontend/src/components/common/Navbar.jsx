import {
  Grid2X2,
  Home,
  Settings,
  Users,
  LifeBuoy,
  Menu,
  X,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import React, { useState, useEffect, useRef } from "react";

const navButtonClasses =
  // Layout
  "flex " +
  // Alignment
  "items-center " +
  // Spacing between elements
  "gap-2 " +
  // Transition effects
  "motion-safe:transition-all " +
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
// const dividerClasses = "text-accent";

const navButtons = [
  { to: "/", icon: Home, label: "Dashboard" },
  { to: "/apps", icon: Grid2X2, label: "Apps" },
  { to: "/users", icon: Users, label: "Users" },
  { to: "/settings", icon: Settings, label: "Settings" },
  { to: "/help", icon: LifeBuoy, label: "Help" },
];

export default function Navbar() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const firstNavLinkRef = useRef(null);
  useEffect(() => {
    if (!isMobileMenuOpen) {
      document.body.style.overflow = "";
      return;
    }
    firstNavLinkRef.current?.focus();
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsMobileMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileMenuOpen]);
  return (
    <>
      <div className="hidden xl:flex">
        <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 min-w-screen pl-6 pr-6">
          <div className="bg-secondary text-primary rounded-pill px-6 py-3">
            <div className="flex items-center gap-6 text-sm font-sans justify-center">
              {navButtons.map((item) => {
                return (
                  <React.Fragment key={`desktopNav-${item.to}`}>
                    <NavLink to={item.to} className={navButtonClasses}>
                      <item.icon size={18} />
                      <span>{item.label}</span>
                    </NavLink>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </nav>
      </div>
      <button
        className={`fixed h-16 w-16 bottom-6 right-6 z-1000 xl:hidden bg-secondary text-primary rounded-pill`}
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        aria-label={isMobileMenuOpen ? "Close Navigation" : "Open Navigation"}
        aria-expanded={isMobileMenuOpen}
        ref={menuButtonRef}
      >
        <div className="relative w-full h-full items-center justify-center flex">
          <X
            className={`absolute motion-safe:transition-all ease-[cubic-bezier(0.2, 0, 0, 1)] ${isMobileMenuOpen ? "opacity-100 rotate-0 scale-100" : "opacity-0 -rotate-90 scale-50"}`}
            size={36}
          />
          <Menu
            className={`absolute motion-safe:transition-all ease-[cubic-bezier(0.2, 0, 0, 1)] ${isMobileMenuOpen ? "opacity-0 rotate-90 scale-50" : "opacity-100 rotate-0 scale-100"}`}
            size={36}
          />
        </div>
      </button>
      <div
        className={`fixed inset-0 motion-safe:transition-all duration-200 bg-secondary z-999 ${isMobileMenuOpen ? "opacity-10" : "opacity-0 pointer-events-none"}`}
        onClick={() => setIsMobileMenuOpen(false)}
      ></div>
      <div
        className={`fixed top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 motion-safe:transition-all z-2000 xl:hidden ${isMobileMenuOpen ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none"}`}
        role="dialog"
        aria-modal="true"
      >
        <nav className="flex flex-col w-[50vw] relative bg-secondary text-primary rounded-large-element justify-start max-h-[75vh] overflow-y-auto">
          <div className="p-2.5 gap-1 flex flex-col">
            {navButtons.map((item, index) => {
              return (
                <React.Fragment key={`mobileNav-${item.to}`}>
                  <NavLink
                    to={item.to}
                    className={`justify-center border-6 border-secondary py-4 ${navButtonClasses}`}
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      menuButtonRef.current?.focus();
                    }}
                    ref={index === 0 ? firstNavLinkRef : null}
                  >
                    <item.icon size={18} />
                    <span>{item.label}</span>
                  </NavLink>
                </React.Fragment>
              );
            })}
          </div>
        </nav>
      </div>
    </>
  );
}
