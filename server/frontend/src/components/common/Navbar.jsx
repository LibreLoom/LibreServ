import {
  Grid2X2,
  Home,
  Settings,
  Users,
  LifeBuoy,
  Menu,
  X,
  User,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import React, { useState, useEffect, useRef, useCallback } from "react";

/**
 * Shared transition configuration for consistent animations across the navbar.
 */
const TRANSITION = {
  duration: "duration-200",
  ease: "ease-out",
  base: "motion-safe:transition-all duration-300",
  full: "motion-safe:transition-all duration-300 ease-out",
};

/**
 * Shared Tailwind CSS classes for navigation buttons.
 * Uses aria-[current=page] to style the active link based on React Router's state.
 */
const navButtonClasses =
  // Layout
  "flex " +
  // Alignment
  "items-center " +
  // Spacing between elements
  "gap-2 " +
  // Transition effects
  `${TRANSITION.base} ` +
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
  "hover:aria-[current=page]:outline-solid " +
  // Keyboard focus styles
  "focus-visible:outline-2 " +
  "focus-visible:outline-accent " +
  "focus-visible:outline-offset-2";

/**
 * Shared classes for popup menu items with hover states.
 */
const menuItemClasses = `flex items-center gap-2 px-3 py-2 rounded-pill ${TRANSITION.base}`;

/**
 * Configuration for navigation links to maintain a single source of truth
 * for both desktop and mobile menus.
 */
const navButtons = [
  { to: "/", icon: Home, label: "Dashboard" },
  { to: "/apps", icon: Grid2X2, label: "Apps" },
  { to: "/users", icon: Users, label: "Users" },
  { to: "/settings", icon: Settings, label: "Settings" },
  { to: "/help", icon: LifeBuoy, label: "Help" },
];

// FAB snap positions
const FAB_SIZE = 64; // 16 * 4 = 64px (h-16 w-16)
const EDGE_PADDING = 24; // 6 * 4 = 24px (bottom-6 right-6)
const SNAP_THRESHOLD = 80; // Distance to snap to corner vs edge center

function getSnapPosition(x, y, windowWidth, windowHeight) {
  const centerX = windowWidth / 2 - FAB_SIZE / 2;
  const centerY = windowHeight / 2 - FAB_SIZE / 2;
  const minX = EDGE_PADDING;
  const maxX = windowWidth - FAB_SIZE - EDGE_PADDING;
  const minY = EDGE_PADDING;
  const maxY = windowHeight - FAB_SIZE - EDGE_PADDING;

  // Determine which edge is closest
  const distToLeft = x;
  const distToRight = windowWidth - x - FAB_SIZE;
  const distToTop = y;
  const distToBottom = windowHeight - y - FAB_SIZE;

  const minHorizontal = Math.min(distToLeft, distToRight);
  const minVertical = Math.min(distToTop, distToBottom);

  let targetX, targetY;

  if (minHorizontal < minVertical) {
    // Snap to left or right edge
    targetX = distToLeft < distToRight ? minX : maxX;
    // Check if close to corner or center
    if (y < SNAP_THRESHOLD + minY) {
      targetY = minY;
    } else if (y > maxY - SNAP_THRESHOLD) {
      targetY = maxY;
    } else {
      targetY = centerY;
    }
  } else {
    // Snap to top or bottom edge
    targetY = distToTop < distToBottom ? minY : maxY;
    // Check if close to corner or center
    if (x < SNAP_THRESHOLD + minX) {
      targetX = minX;
    } else if (x > maxX - SNAP_THRESHOLD) {
      targetX = maxX;
    } else {
      targetX = centerX;
    }
  }

  return { x: targetX, y: targetY };
}

export default function Navbar() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [user, setUser] = useState(null);
  const menuButtonRef = useRef(null);
  const firstNavLinkRef = useRef(null);
  const dialogRef = useRef(null);
  const mobileMenuId = "mobile-nav-menu";

  // FAB dragging state
  const [fabPosition, setFabPosition] = useState(() => {
    // Default position
    const defaultPos = {
      x:
        typeof window !== "undefined"
          ? window.innerWidth - FAB_SIZE - EDGE_PADDING
          : 0,
      y:
        typeof window !== "undefined"
          ? window.innerHeight - FAB_SIZE - EDGE_PADDING
          : 0,
    };

    // Try to load saved position from localStorage
    try {
      const saved = localStorage.getItem("fabPosition");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          // Validate saved position is still within bounds
          if (typeof window !== "undefined") {
            return getSnapPosition(
              parsed.x,
              parsed.y,
              window.innerWidth,
              window.innerHeight,
            );
          }
          return parsed;
        }
      }
    } catch {
      // Ignore localStorage errors
    }
    return defaultPos;
  });
  const [isDragging, setIsDragging] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, fabX: 0, fabY: 0 });
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastPosRef = useRef({ x: 0, y: 0, time: 0 });
  const animationRef = useRef(null);
  const hasDraggedRef = useRef(false);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      setFabPosition((prev) => {
        if (prev.x === null) return prev;
        const snap = getSnapPosition(
          prev.x,
          prev.y,
          window.innerWidth,
          window.innerHeight,
        );
        return snap;
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleDragStart = useCallback(
    (clientX, clientY) => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      setIsDragging(true);
      setIsAnimating(false);
      dragStartRef.current = {
        x: clientX,
        y: clientY,
        fabX: fabPosition.x,
        fabY: fabPosition.y,
      };
      lastPosRef.current = { x: clientX, y: clientY, time: Date.now() };
      velocityRef.current = { x: 0, y: 0 };
      hasDraggedRef.current = false;
    },
    [fabPosition],
  );

  const handleDragMove = useCallback(
    (clientX, clientY) => {
      if (!isDragging) return;

      const now = Date.now();
      const dt = now - lastPosRef.current.time;
      if (dt > 0) {
        velocityRef.current = {
          x: ((clientX - lastPosRef.current.x) / dt) * 16,
          y: ((clientY - lastPosRef.current.y) / dt) * 16,
        };
      }
      lastPosRef.current = { x: clientX, y: clientY, time: now };

      const deltaX = clientX - dragStartRef.current.x;
      const deltaY = clientY - dragStartRef.current.y;

      // Mark as dragged if moved more than 5px
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        hasDraggedRef.current = true;
      }

      let newX = dragStartRef.current.fabX + deltaX;
      let newY = dragStartRef.current.fabY + deltaY;

      // Clamp to screen bounds
      newX = Math.max(
        EDGE_PADDING,
        Math.min(newX, window.innerWidth - FAB_SIZE - EDGE_PADDING),
      );
      newY = Math.max(
        EDGE_PADDING,
        Math.min(newY, window.innerHeight - FAB_SIZE - EDGE_PADDING),
      );

      setFabPosition({ x: newX, y: newY });
    },
    [isDragging],
  );

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);

    // Apply momentum
    let currentX = fabPosition.x;
    let currentY = fabPosition.y;
    let velX = velocityRef.current.x;
    let velY = velocityRef.current.y;

    const animate = () => {
      const friction = 0.92;
      velX *= friction;
      velY *= friction;

      currentX += velX;
      currentY += velY;

      // Clamp to bounds
      currentX = Math.max(
        EDGE_PADDING,
        Math.min(currentX, window.innerWidth - FAB_SIZE - EDGE_PADDING),
      );
      currentY = Math.max(
        EDGE_PADDING,
        Math.min(currentY, window.innerHeight - FAB_SIZE - EDGE_PADDING),
      );

      // Stop if velocity is low enough
      if (Math.abs(velX) < 0.5 && Math.abs(velY) < 0.5) {
        // Snap to position
        const snap = getSnapPosition(
          currentX,
          currentY,
          window.innerWidth,
          window.innerHeight,
        );
        setIsAnimating(true);
        setFabPosition(snap);
        // Save to localStorage
        try {
          localStorage.setItem("fabPosition", JSON.stringify(snap));
        } catch {
          // Ignore localStorage errors
        }
        setTimeout(() => setIsAnimating(false), 300);
        return;
      }

      setFabPosition({ x: currentX, y: currentY });
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
  }, [isDragging, fabPosition]);

  // Mouse events
  useEffect(() => {
    const handleMouseMove = (e) => handleDragMove(e.clientX, e.clientY);
    const handleMouseUp = () => handleDragEnd();

    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleDragMove, handleDragEnd]);

  // Touch events
  useEffect(() => {
    const handleTouchMove = (e) => {
      if (e.touches.length === 1) {
        handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const handleTouchEnd = () => handleDragEnd();

    if (isDragging) {
      window.addEventListener("touchmove", handleTouchMove, { passive: true });
      window.addEventListener("touchend", handleTouchEnd);
      window.addEventListener("touchcancel", handleTouchEnd);
    }

    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [isDragging, handleDragMove, handleDragEnd]);

  // Fetch user data
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await fetch("/api/v1/auth/me", {
          credentials: "include",
        });
        const userData = await response.json();
        setUser(userData);
      } catch (err) {
        console.error("Failed to fetch user:", err);
      }
    };
    fetchUser();
  }, []);

  // Handle side effects for the mobile menu (focus trapping, scroll locking, and ESC key)
  useEffect(() => {
    if (!isMobileMenuOpen) {
      document.body.style.overflow = "";
      return;
    }

    // Accessibility: Focus the first link when menu opens
    firstNavLinkRef.current?.focus();
    // Prevent background scrolling when menu is active
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsMobileMenuOpen(false);
        menuButtonRef.current?.focus();
      }

      if (event.key === "Tab") {
        const focusableElements = dialogRef.current?.querySelectorAll(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusableElements || focusableElements.length === 0) return;
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileMenuOpen]);

  return (
    <>
      {/* Desktop Navigation: Visible only on XL screens and up */}
      <div className="hidden xl:flex">
        <nav
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 min-w-screen pl-6 pr-6"
          aria-label="Primary"
        >
          <div className="bg-secondary text-primary rounded-pill px-3 py-3 outline-2 outline-accent flex items-center gap-6">
            <span className="font-mono px-3 py-1.5 flex items-center">
              LibreServ
            </span>
            <div className="flex items-center gap-6 text-sm font-sans justify-center flex-1">
              {navButtons.map((item) => {
                return (
                  <React.Fragment key={`desktopNav-${item.to}`}>
                    <NavLink to={item.to} className={navButtonClasses}>
                      <item.icon size={18} aria-hidden="true" />
                      <span>{item.label}</span>
                    </NavLink>
                  </React.Fragment>
                );
              })}
            </div>
            <div className="group flex items-center gap-2 relative">
              <span
                className={`font-semibold text-sm inline-block min-w-[6ch] max-w-[18ch] truncate ${TRANSITION.full} ${user?.username ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"} translate-y-[-0.5px]`}
                title={user?.username || ""}
              >
                {user?.username || ""}
              </span>
              <div className="h-8 w-8 rounded-full bg-primary text-secondary flex items-center justify-center">
                <User size={16} aria-hidden="true" />
              </div>

              {/* User Controls Popup */}
              <div
                className={`absolute bottom-0 right-0 pb-16 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto ${TRANSITION.full}`}
              >
                <div
                  className={`bg-secondary rounded-2xl outline-2 outline-accent px-4 py-3 flex flex-col gap-2 min-w-48 translate-y-2 group-hover:translate-y-0 ${TRANSITION.full}`}
                >
                  <NavLink
                    to="/users"
                    className={`${menuItemClasses} hover:bg-primary hover:text-secondary`}
                  >
                    <Users size={16} />
                    <span className="text-sm font-semibold">Manage Users</span>
                  </NavLink>
                  <NavLink
                    to={`/users/${user?.id || ""}`}
                    className={`${menuItemClasses} hover:bg-primary hover:text-secondary`}
                  >
                    <Settings size={16} />
                    <span className="text-sm font-semibold">
                      Manage Profile
                    </span>
                  </NavLink>
                  <button
                    onClick={async () => {
                      try {
                        await fetch("/api/v1/auth/logout", {
                          method: "POST",
                          credentials: "include",
                        });
                        window.location.href = "/";
                      } catch (err) {
                        console.error("Logout failed:", err);
                      }
                    }}
                    className={`${menuItemClasses} hover:bg-accent hover:text-primary text-left`}
                  >
                    <X size={16} />
                    <span className="text-sm font-semibold">Sign Out</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </nav>
      </div>

      {/* Mobile Floating Action Button (FAB): Toggles the menu */}
      <button
        type="button"
        className={`${TRANSITION.base} fixed h-16 w-16 z-1000 xl:hidden bg-secondary text-primary rounded-pill border-2 border-accent select-none touch-none ${isAnimating ? TRANSITION.full : ""} ${isMobileMenuOpen ? "" : "opacity-100 scale-100"} ${isDragging ? "cursor-grabbing scale-110" : "cursor-grab"}`}
        style={
          fabPosition.x !== null
            ? { left: fabPosition.x, top: fabPosition.y }
            : { bottom: EDGE_PADDING, right: EDGE_PADDING }
        }
        onClick={() => {
          // Only open menu if user didn't drag
          if (!hasDraggedRef.current) {
            setIsMobileMenuOpen(!isMobileMenuOpen);
          }
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          handleDragStart(e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          if (e.touches.length === 1) {
            handleDragStart(e.touches[0].clientX, e.touches[0].clientY);
          }
        }}
        aria-label={isMobileMenuOpen ? "Close Navigation" : "Open Navigation"}
        aria-expanded={isMobileMenuOpen}
        aria-controls={mobileMenuId}
        ref={menuButtonRef}
      >
        <div className="relative w-full h-full items-center justify-center flex">
          {/* Animated Icon Switch: X and Menu icons cross-fade and rotate */}
          <X
            aria-hidden="true"
            className={`absolute ${TRANSITION.base} ease-[cubic-bezier(0.2,0,0,1)] ${isMobileMenuOpen ? "opacity-100 rotate-0 scale-100" : "opacity-0 -rotate-90 scale-50"}`}
            size={36}
          />
          <Menu
            aria-hidden="true"
            className={`absolute ${TRANSITION.base} ease-[cubic-bezier(0.2,0,0,1)] ${isMobileMenuOpen ? "opacity-0 rotate-90 scale-50" : "opacity-100 rotate-0 scale-100"}`}
            size={36}
          />
        </div>
      </button>

      {/* Backdrop Overlay: Closes menu when clicking outside */}
      <button
        type="button"
        className={`fixed inset-0 ${TRANSITION.base} bg-secondary z-999 ${isMobileMenuOpen ? "opacity-10" : "opacity-0 pointer-events-none"}`}
        onClick={() => {
          setIsMobileMenuOpen(false);
          menuButtonRef.current?.focus();
        }}
        aria-label="Close navigation menu"
        aria-hidden={!isMobileMenuOpen}
        tabIndex={isMobileMenuOpen ? 0 : -1}
      ></button>

      {/* Mobile Menu Dialog */}
      <dialog
        id={mobileMenuId}
        ref={dialogRef}
        className={`fixed top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 z-2000 xl:hidden bg-transparent ${TRANSITION.full} ${isMobileMenuOpen ? "opacity-100 visible scale-100" : "opacity-0 invisible scale-95"}`}
        open
        aria-modal="true"
        role="dialog"
        aria-label="Primary navigation"
      >
        <nav
          className="flex flex-col w-[50vw] relative bg-secondary text-primary rounded-3xl justify-start outline-2 outline-accent"
          aria-label="Primary"
        >
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
                    // Attach ref to first item for focus management
                    ref={index === 0 ? firstNavLinkRef : null}
                  >
                    <item.icon size={18} aria-hidden="true" />
                    <span>{item.label}</span>
                  </NavLink>
                </React.Fragment>
              );
            })}
          </div>
          <div className="h-px bg-primary/20 mx-4" aria-hidden="true" />
          <div className="p-2.5">
            <button
              type="button"
              onClick={async () => {
                try {
                  await fetch("/api/v1/auth/logout", {
                    method: "POST",
                    credentials: "include",
                  });
                  window.location.href = "/";
                } catch (err) {
                  console.error("Logout failed:", err);
                }
              }}
              className={`w-full justify-center border-6 border-secondary py-4 ${navButtonClasses}`}
            >
              <X size={18} aria-hidden="true" />
              <span>Sign Out</span>
            </button>
          </div>
        </nav>
      </dialog>
    </>
  );
}
