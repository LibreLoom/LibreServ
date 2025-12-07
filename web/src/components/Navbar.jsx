import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, 
  AppWindow, 
  Users, 
  Settings, 
  HelpCircle,
  User,
  Menu,
  X,
  GripVertical
} from 'lucide-react';
import { useNavigation } from '../context/NavigationContext';
import { useTheme } from '../context/ThemeContext';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/apps', label: 'Apps', icon: AppWindow },
  { path: '/users', label: 'Users', icon: Users },
  { path: '/settings', label: 'Settings', icon: Settings },
  { path: '/support', label: 'Support', icon: HelpCircle },
];

export default function Navbar({ user }) {
  const location = useLocation();
  const { isMobile, isMenuOpen, toggleMenu, closeMenu, hamburgerPosition, flingToCorner } = useNavigation();
  const { haptic } = useTheme();
  
  // Drag state for hamburger
  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const startPosRef = useRef({ x: 0, y: 0 });

  // Handle drag start
  const handleDragStart = (e) => {
    if (!isMobile) return;
    
    const clientX = e.touches?.[0]?.clientX ?? e.clientX;
    const clientY = e.touches?.[0]?.clientY ?? e.clientY;
    
    startPosRef.current = { x: clientX, y: clientY };
    setIsDragging(true);
    haptic('light');
  };

  // Handle drag move
  const handleDragMove = (e) => {
    if (!isDragging) return;
    
    const clientX = e.touches?.[0]?.clientX ?? e.clientX;
    const clientY = e.touches?.[0]?.clientY ?? e.clientY;
    
    setDragPos({
      x: clientX - startPosRef.current.x,
      y: clientY - startPosRef.current.y,
    });
  };

  // Handle drag end - fling to nearest corner
  const handleDragEnd = () => {
    if (!isDragging) return;
    
    const rect = dragRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const centerX = rect.left + rect.width / 2 + dragPos.x;
    const centerY = rect.top + rect.height / 2 + dragPos.y;
    
    const isLeft = centerX < window.innerWidth / 2;
    const isTop = centerY < window.innerHeight / 2;
    
    const corner = `${isTop ? 'top' : 'bottom'}-${isLeft ? 'left' : 'right'}`;
    flingToCorner(corner);
    
    setIsDragging(false);
    setDragPos({ x: 0, y: 0 });
    haptic('medium');
  };

  // Attach global listeners for drag
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
      window.addEventListener('touchmove', handleDragMove);
      window.addEventListener('touchend', handleDragEnd);
      
      return () => {
        window.removeEventListener('mousemove', handleDragMove);
        window.removeEventListener('mouseup', handleDragEnd);
        window.removeEventListener('touchmove', handleDragMove);
        window.removeEventListener('touchend', handleDragEnd);
      };
    }
  }, [isDragging, dragPos]);

  // Close menu on route change
  useEffect(() => {
    closeMenu();
  }, [location.pathname]);

  // Get hamburger position styles
  const getHamburgerStyles = () => {
    const base = {
      position: 'fixed',
      zIndex: 50,
      transform: isDragging ? `translate(${dragPos.x}px, ${dragPos.y}px)` : 'none',
      transition: isDragging ? 'none' : 'all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
    };

    switch (hamburgerPosition.corner) {
      case 'top-left':
        return { ...base, top: '1rem', left: '1rem' };
      case 'top-right':
        return { ...base, top: '1rem', right: '1rem' };
      case 'bottom-left':
        return { ...base, bottom: '1rem', left: '1rem' };
      case 'bottom-right':
      default:
        return { ...base, bottom: '1rem', right: '1rem' };
    }
  };

  // Mobile: Hamburger button + expandable menu
  if (isMobile) {
    return (
      <>
        {/* Hamburger Button */}
        <div
          ref={dragRef}
          style={getHamburgerStyles()}
          className="touch-none"
        >
          <button
            onClick={() => {
              if (!isDragging) {
                toggleMenu();
                haptic('medium');
              }
            }}
            onMouseDown={handleDragStart}
            onTouchStart={handleDragStart}
            className={`
              w-14 h-14 rounded-full
              bg-[var(--color-secondary)] text-[var(--color-primary)]
              flex items-center justify-center
              border-2 border-[var(--color-secondary)]
              transition-transform duration-300
              ${isMenuOpen ? 'rotate-90' : ''}
              active:scale-95
            `}
            aria-label="Toggle menu"
          >
            {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          
          {/* Drag hint indicator */}
          {!isMenuOpen && (
            <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--color-accent)] flex items-center justify-center opacity-50">
              <GripVertical size={10} />
            </div>
          )}
        </div>

        {/* Expanded Menu */}
        {isMenuOpen && (
          <>
            {/* Backdrop */}
            <div 
              className="fixed inset-0 bg-[var(--color-secondary)]/20 z-40 animate-fade-in"
              onClick={closeMenu}
            />
            
            {/* Menu Panel */}
            <nav 
              className={`
                fixed z-50 
                bg-[var(--color-primary)] 
                border-2 border-[var(--color-secondary)] 
                rounded-3xl
                p-4
                animate-pop-in
                ${hamburgerPosition.corner.includes('bottom') ? 'bottom-20' : 'top-20'}
                ${hamburgerPosition.corner.includes('right') ? 'right-4' : 'left-4'}
              `}
            >
              <div className="flex flex-col gap-2">
                {navItems.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => haptic('light')}
                    className={({ isActive }) => `
                      flex items-center gap-3 px-4 py-3 rounded-full
                      font-mono text-sm
                      transition-all duration-200
                      ${isActive 
                        ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                        : 'hover:bg-[var(--color-secondary)]/10'
                      }
                    `}
                  >
                    <item.icon size={18} />
                    {item.label}
                  </NavLink>
                ))}
                
                {/* Divider */}
                <div className="h-px bg-[var(--color-accent)] my-2" />
                
                {/* User */}
                <NavLink
                  to="/profile"
                  onClick={() => haptic('light')}
                  className={({ isActive }) => `
                    flex items-center gap-3 px-4 py-3 rounded-full
                    font-mono text-sm
                    transition-all duration-200
                    ${isActive 
                      ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                      : 'hover:bg-[var(--color-secondary)]/10'
                    }
                  `}
                >
                  <div className="w-6 h-6 rounded-full border-2 border-current flex items-center justify-center text-xs">
                    {user?.username?.charAt(0).toUpperCase() || 'U'}
                  </div>
                  {user?.username || 'Profile'}
                </NavLink>
              </div>
            </nav>
          </>
        )}
      </>
    );
  }

  // Desktop: Floating bottom navbar
  return (
    <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-slide-up">
      <div className="
        flex items-center gap-1
        bg-[var(--color-primary)]
        border-2 border-[var(--color-secondary)]
        rounded-full
        px-2 py-2
      ">
        {/* Brand */}
        <div className="px-4 font-mono font-bold text-sm">
          LibreServ
        </div>
        
        {/* Divider */}
        <div className="w-px h-8 bg-[var(--color-accent)]" />
        
        {/* Nav Items */}
        <div className="flex items-center gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={() => haptic('light')}
              className={({ isActive }) => `
                flex items-center gap-2 px-4 py-2 rounded-full
                font-mono text-sm
                transition-all duration-200
                ${isActive 
                  ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                  : 'hover:bg-[var(--color-secondary)]/10'
                }
              `}
            >
              <item.icon size={16} />
              <span className="hidden lg:inline">{item.label}</span>
            </NavLink>
          ))}
        </div>
        
        {/* Divider */}
        <div className="w-px h-8 bg-[var(--color-accent)]" />
        
        {/* User */}
        <NavLink
          to="/profile"
          onClick={() => haptic('light')}
          className={({ isActive }) => `
            flex items-center gap-2 px-4 py-2 rounded-full
            font-mono text-sm
            transition-all duration-200
            ${isActive 
              ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
              : 'hover:bg-[var(--color-secondary)]/10'
            }
          `}
        >
          <div className="w-6 h-6 rounded-full border-2 border-current flex items-center justify-center text-xs">
            {user?.username?.charAt(0).toUpperCase() || 'U'}
          </div>
          <span className="hidden lg:inline">{user?.username || 'Profile'}</span>
        </NavLink>
      </div>
    </nav>
  );
}
