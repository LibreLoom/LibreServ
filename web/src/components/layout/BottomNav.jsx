import { useState, useRef, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Home, Users, Settings, HelpCircle, Menu, X, User } from 'lucide-react';
import { Divider } from '../ui';

const BottomNav = ({ user }) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const profileRef = useRef(null);

  // Close profile menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setIsProfileOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const navItems = [
    { to: '/', label: 'Dashboard', icon: Home },
    { to: '/users', label: 'Users', icon: Users },
    { to: '/settings', label: 'Settings', icon: Settings },
    { to: '/support', label: 'Support', icon: HelpCircle },
  ];

  return (
    <>
      {/* Desktop/Tablet Navigation */}
      <nav className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 hidden sm:flex">
        <div className="flex items-center h-14 px-4 bg-[var(--color-primary)] border-2 border-[var(--color-secondary)] rounded-full">
          {/* Brand */}
          <span className="font-mono text-sm font-bold px-3">LibreServ</span>
          
          <Divider orientation="vertical" />
          
          {/* Nav Links */}
          <div className="flex items-center gap-1 px-3">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `
                  flex items-center gap-2 px-3 py-1.5
                  font-mono text-sm
                  rounded-full
                  transition-colors duration-[var(--transition-fast)]
                  ${isActive 
                    ? 'border-2 border-[var(--color-secondary)]' 
                    : 'hover:bg-[var(--color-secondary)]/10'
                  }
                `}
              >
                <item.icon size={16} />
                <span className="hidden md:inline">{item.label}</span>
              </NavLink>
            ))}
          </div>
          
          <Divider orientation="vertical" />
          
          {/* User Profile */}
          <div className="relative px-3" ref={profileRef}>
            <button
              onClick={() => setIsProfileOpen(!isProfileOpen)}
              className="flex items-center gap-2 px-2 py-1 rounded-full hover:bg-[var(--color-secondary)]/10 transition-colors"
            >
              <div className="w-8 h-8 rounded-full border-2 border-[var(--color-secondary)] flex items-center justify-center">
                <User size={16} />
              </div>
              <span className="font-mono text-sm hidden lg:inline">
                {user?.username || 'User'}
              </span>
            </button>

            {/* Profile Dropdown */}
            {isProfileOpen && (
              <div className="absolute bottom-full right-0 mb-2 w-48 bg-[var(--color-primary)] border-2 border-[var(--color-secondary)] rounded-2xl overflow-hidden animate-scale-in">
                <NavLink
                  to="/users"
                  className="block px-4 py-3 font-mono text-sm hover:bg-[var(--color-secondary)]/10 transition-colors"
                  onClick={() => setIsProfileOpen(false)}
                >
                  Manage Users
                </NavLink>
                <NavLink
                  to="/profile"
                  className="block px-4 py-3 font-mono text-sm hover:bg-[var(--color-secondary)]/10 transition-colors"
                  onClick={() => setIsProfileOpen(false)}
                >
                  Profile
                </NavLink>
                <button
                  className="w-full text-left px-4 py-3 font-mono text-sm hover:bg-[var(--color-secondary)]/10 transition-colors text-red-500"
                  onClick={() => {
                    setIsProfileOpen(false);
                    // TODO: Handle sign out
                  }}
                >
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Mobile Navigation */}
      <nav className="fixed bottom-4 right-4 z-50 sm:hidden">
        <button
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="w-14 h-14 flex items-center justify-center bg-[var(--color-primary)] border-2 border-[var(--color-secondary)] rounded-full"
        >
          {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        {/* Mobile Menu */}
        {isMenuOpen && (
          <div className="absolute bottom-16 right-0 w-48 bg-[var(--color-primary)] border-2 border-[var(--color-secondary)] rounded-2xl overflow-hidden animate-scale-in">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `
                  flex items-center gap-3 px-4 py-3
                  font-mono text-sm
                  transition-colors
                  ${isActive 
                    ? 'bg-[var(--color-secondary)]/10' 
                    : 'hover:bg-[var(--color-secondary)]/10'
                  }
                `}
                onClick={() => setIsMenuOpen(false)}
              >
                <item.icon size={18} />
                {item.label}
              </NavLink>
            ))}
            <div className="border-t-2 border-[var(--color-secondary)]">
              <button
                className="w-full flex items-center gap-3 px-4 py-3 font-mono text-sm text-red-500 hover:bg-[var(--color-secondary)]/10 transition-colors"
                onClick={() => {
                  setIsMenuOpen(false);
                  // TODO: Handle sign out
                }}
              >
                Sign Out
              </button>
            </div>
          </div>
        )}
      </nav>
    </>
  );
};

export default BottomNav;
