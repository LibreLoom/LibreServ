import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const NavigationContext = createContext(null);

export function NavigationProvider({ children }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  
  // Hamburger button position (for dragging/flinging)
  const [hamburgerPosition, setHamburgerPosition] = useState(() => {
    try {
      const saved = localStorage.getItem('libreserv-hamburger-pos');
      return saved ? JSON.parse(saved) : { corner: 'bottom-right' };
    } catch {
      return { corner: 'bottom-right' };
    }
  });

  // Check if mobile
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Save hamburger position
  useEffect(() => {
    localStorage.setItem('libreserv-hamburger-pos', JSON.stringify(hamburgerPosition));
  }, [hamburgerPosition]);

  const toggleMenu = useCallback(() => {
    setIsMenuOpen(prev => !prev);
  }, []);

  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  const openMenu = useCallback(() => {
    setIsMenuOpen(true);
  }, []);

  // Fling hamburger to a corner
  const flingToCorner = useCallback((corner) => {
    const validCorners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    if (validCorners.includes(corner)) {
      setHamburgerPosition({ corner });
    }
  }, []);

  const value = {
    isMenuOpen,
    isMobile,
    hamburgerPosition,
    toggleMenu,
    closeMenu,
    openMenu,
    flingToCorner,
  };

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
}

export default NavigationContext;
