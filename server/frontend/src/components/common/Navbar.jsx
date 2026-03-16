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
import React, { useState, useEffect, useRef, useMemo } from "react";

const TRANSITION = {
  duration: "duration-200",
  ease: "ease-out",
  base: "motion-safe:transition-all duration-300",
  full: "motion-safe:transition-all duration-300 ease-out",
};

const navButtonClasses =
  "flex " +
  "items-center " +
  "gap-2 " +
  `${TRANSITION.base} ` +
  "px-3 " +
  "py-1.5 " +
  "rounded-pill " +
  "hover:bg-primary " +
  "hover:text-secondary " +
  "aria-[current=page]:bg-primary " +
  "aria-[current=page]:text-secondary " +
  "hover:aria-[current=page]:text-primary " +
  "hover:aria-[current=page]:bg-secondary " +
  "hover:aria-[current=page]:ring-2 " +
  "hover:aria-[current=page]:ring-accent " +
  "hover:aria-[current=page]:ring-offset-2 " +
  "focus-visible:ring-2 " +
  "focus-visible:ring-accent " +
  "focus-visible:ring-offset-2";

const menuItemClasses = `flex items-center gap-2 px-3 py-2 rounded-pill ${TRANSITION.base}`;

const navButtons = [
	{ to: "/", icon: Home, label: "Dashboard" },
	{ to: "/apps", icon: Grid2X2, label: "Apps" },
	{ to: "/users", icon: Users, label: "Users" },
	{ to: "/settings", icon: Settings, label: "Settings" },
	{ to: "/help", icon: LifeBuoy, label: "Help" },
];

const FAB_SIZE = 60;

function getSnapPosition(x, y, windowWidth, windowHeight) {
  const snapMargin = 20;
  const maxX = windowWidth - FAB_SIZE - snapMargin;
  const maxY = windowHeight - FAB_SIZE - snapMargin;

  let targetX, targetY;

  if (x < windowWidth / 2) {
    targetX = snapMargin;
  } else {
    targetX = maxX;
  }

  if (y < windowHeight / 2) {
    targetY = snapMargin;
  } else {
    targetY = maxY;
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

  const [position, setPosition] = useState({ x: null, y: null });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hasMoved, setHasMoved] = useState(false);
  const animationFrameRef = useRef(null);
  const pendingPositionRef = useRef(null);

  useEffect(() => {
    const savedPosition = localStorage.getItem("hamburgerPosition");
    if (savedPosition) {
      const parsed = JSON.parse(savedPosition);
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      if (
        parsed.x !== null &&
        parsed.y !== null &&
        parsed.x >= 0 &&
        parsed.x <= windowWidth - FAB_SIZE &&
        parsed.y >= 0 &&
        parsed.y <= windowHeight - FAB_SIZE
      ) {
        setPosition(parsed);
      } else {
        localStorage.removeItem("hamburgerPosition");
        setPosition({ x: null, y: null });
      }
    }
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 1280) {
        setIsMobileMenuOpen(false);
      }

      if (position.x !== null && position.y !== null) {
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        if (
          position.x < 0 ||
          position.x > windowWidth - FAB_SIZE ||
          position.y < 0 ||
          position.y > windowHeight - FAB_SIZE
        ) {
          localStorage.removeItem("hamburgerPosition");
          setPosition({ x: null, y: null });
        }
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [position]);

  const handleDragStart = (e) => {
    if (window.innerWidth >= 1280) return;

    e.preventDefault();

    const clientX = e.type.includes("mouse") ? e.clientX : e.touches[0].clientX;
    const clientY = e.type.includes("mouse") ? e.clientY : e.touches[0].clientY;

    let currentX = position.x;
    let currentY = position.y;

    if (currentX === null || currentY === null) {
      const rect = menuButtonRef.current?.getBoundingClientRect();
      if (rect) {
        currentX = rect.left;
        currentY = rect.top;
      }
    }

    setIsDragging(true);
    setHasMoved(false);
    setPosition({ x: currentX, y: currentY });
    setDragStart({
      x: clientX - currentX,
      y: clientY - currentY,
    });
  };

  const handleDrag = (e) => {
    if (!isDragging || window.innerWidth >= 1280) return;

    e.preventDefault();
    const clientX = e.type.includes("mouse") ? e.clientX : e.touches[0].clientX;
    const clientY = e.type.includes("mouse") ? e.clientY : e.touches[0].clientY;

    let newX = clientX - dragStart.x;
    let newY = clientY - dragStart.y;

    const moveThreshold = 5;
    const deltaX = Math.abs(newX - position.x);
    const deltaY = Math.abs(newY - position.y);

    if (!hasMoved && (deltaX > moveThreshold || deltaY > moveThreshold)) {
      setHasMoved(true);
    }

    newX = Math.max(0, Math.min(newX, window.innerWidth - FAB_SIZE));
    newY = Math.max(0, Math.min(newY, window.innerHeight - FAB_SIZE));

    pendingPositionRef.current = { x: newX, y: newY };

    if (!animationFrameRef.current) {
      animationFrameRef.current = requestAnimationFrame(() => {
        if (pendingPositionRef.current) {
          setPosition(pendingPositionRef.current);
          pendingPositionRef.current = null;
        }
        animationFrameRef.current = null;
      });
    }
  };

  const handleDragEnd = () => {
    if (!isDragging || window.innerWidth >= 1280) return;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    setIsDragging(false);

    const currentX = position.x !== null ? position.x : window.innerWidth - 80;
    const currentY = position.y !== null ? position.y : window.innerHeight - 80;

    const snap = getSnapPosition(
      currentX,
      currentY,
      window.innerWidth,
      window.innerHeight,
    );

    setPosition(snap);
    localStorage.setItem("hamburgerPosition", JSON.stringify(snap));
  };

  useEffect(() => {
    if (isDragging) {
      const handleMouseMove = (e) => handleDrag(e);
      const handleMouseUp = () => handleDragEnd();
      const handleTouchMove = (e) => handleDrag(e);
      const handleTouchEnd = () => handleDragEnd();

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.addEventListener("touchmove", handleTouchMove, { passive: false });
      document.addEventListener("touchend", handleTouchEnd);

      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging, position]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const getHamburgerStyle = () => {
    if (position.x === null || position.y === null) {
      return {};
    }
    return {
      left: `${position.x}px`,
      top: `${position.y}px`,
      right: "auto",
      bottom: "auto",
    };
  };

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await fetch("/api/v1/auth/me", {
          credentials: "include",
        });
        const userData = await response.json();
        setUser(userData);
      } catch {
        // Silently handle error - user will be shown as not logged in
      }
    };
    fetchUser();
  }, []);

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

  const navButtonsElements = useMemo(
    () =>
      navButtons.map((item) => (
        <React.Fragment key={`desktopNav-${item.to}`}>
          <NavLink to={item.to} className={navButtonClasses}>
            <item.icon size={18} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        </React.Fragment>
      )),
    [],
  );

  return (
    <>
      <div className="hidden xl:flex">
        <nav
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 min-w-screen pl-6 pr-6"
          aria-label="Primary"
        >
           <div className="bg-secondary text-primary rounded-pill px-3 py-3 ring-2 ring-accent flex items-center gap-6">
            <span className="font-mono px-3 py-1.5 flex items-center">
              LibreServ
            </span>
            <div className="flex items-center gap-6 text-sm font-sans justify-center flex-1">
              {navButtonsElements}
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

              <div
                className={`absolute bottom-0 right-0 pb-16 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto ${TRANSITION.full}`}
              >
                <div
                  className={`bg-secondary rounded-2xl ring-2 ring-accent px-4 py-3 flex flex-col gap-2 min-w-48 translate-y-2 group-hover:translate-y-0 ${TRANSITION.full}`}
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
                      } catch {
                        // Error handled by navigation
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

      <button
        ref={menuButtonRef}
        type="button"
        className={`xl:hidden fixed bottom-5 right-5 flex flex-col justify-center items-center w-[60px] h-[60px] bg-secondary border-2 border-accent rounded-full cursor-grab p-0 z-[1001] touch-none select-none ${isDragging ? "cursor-grabbing scale-105 transition-none" : "transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"} ${isMobileMenuOpen ? "active" : ""}`}
        style={getHamburgerStyle()}
        onClick={() => !hasMoved && setIsMobileMenuOpen(!isMobileMenuOpen)}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        aria-label="Toggle menu"
        aria-expanded={isMobileMenuOpen}
        aria-controls={mobileMenuId}
      >
        <span className={`absolute w-6 h-[3px] bg-primary rounded-[10px] transition-all duration-400 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${isMobileMenuOpen ? "translate-y-0 rotate-45" : "-translate-y-2"}`} />
        <span className={`absolute w-6 h-[3px] bg-primary rounded-[10px] transition-all duration-400 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${isMobileMenuOpen ? "opacity-0 scale-0" : "opacity-100 scale-100"}`} />
        <span className={`absolute w-6 h-[3px] bg-primary rounded-[10px] transition-all duration-400 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${isMobileMenuOpen ? "translate-y-0 -rotate-45" : "translate-y-2"}`} />
      </button>

      <button
        type="button"
        className={`fixed inset-0 ${TRANSITION.base} bg-secondary/60 backdrop-blur-sm z-999 ${isMobileMenuOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={() => {
          setIsMobileMenuOpen(false);
          menuButtonRef.current?.focus();
        }}
        aria-label="Close navigation menu"
        aria-hidden={!isMobileMenuOpen}
        tabIndex={isMobileMenuOpen ? 0 : -1}
      ></button>

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
           className="flex flex-col w-[50vw] relative bg-secondary text-primary rounded-3xl justify-start ring-2 ring-accent"
           aria-label="Primary"
         >
          <div className="p-2.5 gap-1 flex flex-col">
            {navButtons.map((item, index) => (
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
                  <item.icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              </React.Fragment>
            ))}
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
                } catch {
                  // Error handled by navigation
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
