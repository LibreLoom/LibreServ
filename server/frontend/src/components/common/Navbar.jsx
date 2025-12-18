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
import { useState } from "react";

const navButtonClasses =
  "flex items-center gap-2 transition-colors px-3 py-1.5 rounded-pill " +
  "hover:bg-secondary hover:text-primary aria-[current=page]:bg-secondary aria-[current=page]:text-primary hover:aria-[current=page]:text-secondary hover:aria-[current=page]:bg-primary hover:aria-[current=page]:outline-2 hover:aria-[current=page]:outline-secondary hover:aria-[current=page]:outline-solid"; // Hover Inversion Effect & Page Select Effect]"; // Hover Inversion Effect & Page Select Effect

const dividerClasses = "text-accent text-lg";

export default function Navbar() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  return (
    <>
      <div className="hidden xl:flex">
        <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 min-w-screen pl-6 pr-6">
          <div className="bg-primary text-secondary border-2 border-accent rounded-pill px-6 py-3">
            <div className="flex items-center gap-6 text-sm font-sans justify-center">
              <NavLink to="/" className={navButtonClasses}>
                <Home size={18} />
                <span>Dashboard</span>
              </NavLink>

              <span className={dividerClasses}>|</span>

              <NavLink to="/apps" className={navButtonClasses}>
                <Grid2X2 size={18} />
                <span>Apps</span>
              </NavLink>

              <span className={dividerClasses}>|</span>

              <NavLink to="/users" className={navButtonClasses}>
                <Users size={18} />
                <span>Users</span>
              </NavLink>

              <span className={dividerClasses}>|</span>

              <NavLink to="/settings" className={navButtonClasses}>
                <Settings size={18} />
                <span>Settings</span>
              </NavLink>

              <span className={dividerClasses}>|</span>

              <NavLink to="/help" className={navButtonClasses}>
                <LifeBuoy size={18} />
                <span>Help</span>
              </NavLink>
            </div>
          </div>
        </nav>
      </div>
      <button
        className="fixed bottom-6 right-6 z-1000 xl:hidden bg-primary text-secondary border-2 border-accent rounded-pill"
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
      >
        {isMobileMenuOpen ? (
          <X className="p-2.5" size={48} />
        ) : (
          <Menu className="p-2.5" size={48} />
        )}
      </button>
    </>
  );
}
