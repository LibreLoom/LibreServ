import { User, X } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import React, { useState, useEffect, useRef, useMemo } from "react";
import { cn } from "../../lib/utils.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";
import { haptic } from "../../utils/haptics.js";
import { useShortcut, useShortcutsSheet } from "../../context/ShortcutsContext.jsx";
import { DesktopNavGroup, MobileNavGroup } from "./NavGroup.jsx";
import { useGroupTarget } from "../../hooks/useNavGroup.js";

const TRANSITION = {
  duration: "duration-200",
  ease: "ease-out",
  base: "motion-safe:transition-[color,background-color,border-color,box-shadow,opacity,translate,scale,rotate,visibility] duration-300",
  full: "motion-safe:transition-[color,background-color,border-color,box-shadow,opacity,translate,scale,rotate,visibility] duration-300 ease-out",
};

const navButtonBaseClasses = cn(
  "flex",
  "items-center",
  "gap-2",
  "px-3",
  "py-1.5",
  "rounded-pill",
  "hover:bg-primary",
  "hover:text-secondary",
  "aria-[current=page]:bg-primary",
  "aria-[current=page]:text-secondary",
  "hover:aria-[current=page]:text-primary",
  "hover:aria-[current=page]:bg-secondary",
  "hover:aria-[current=page]:ring-3",
  "hover:aria-[current=page]:ring-accent",
  "focus-visible:ring-3",
  "focus-visible:ring-accent",
);

const navButtonClasses = cn(navButtonBaseClasses, TRANSITION.base);

const menuItemClasses = cn("flex", "items-center", "gap-2", "px-3", "py-2", "rounded-pill", TRANSITION.base);

// Mobile menu items: hover states must flip instantly — no TRANSITION classes.
// (Menu open/close animation lives on the dialog itself, not these items.)
const mobileMenuItemClasses = cn(
  "w-full",
  "justify-start",
  "px-5",
  "py-3.5",
  "text-base",
  navButtonBaseClasses,
);

const FAB_SIZE = 60;
// While a fullscreen editor is open the FAB may only live in the headerbar
// strip at the top of the screen (editor-topbar h-10 / EuroOffice's
// toolbar). Below this line — over the sidebar or document — it must not
// render.
const EDITOR_HEADERBAR_HEIGHT = 48;

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

/** Alt+Shift+<position> jumps to that navbar item, so the keys follow what this user can see. */
function NavShortcut({ item, position, enabled }) {
  const navigate = useNavigate();
  useShortcut(`Alt+Shift+${position}`, () => navigate(item.to), {
    label: `Go to ${item.label}`,
    group: "Go to",
    enabled,
  });
  return null;
}

/** Same shortcut for a group: it opens the sub-page used last. */
function NavGroupShortcut({ item, position, enabled }) {
  const to = useGroupTarget(item);
  return <NavShortcut item={{ ...item, to }} position={position} enabled={enabled} />;
}

/** Stable key for an item or a group (groups have no `to`). */
const navKey = (item) => item.to ?? `group:${item.key}`;

/**
 * The bottom navigation shared by every LibreLoom product: a pill on desktop,
 * a draggable menu button plus dialog on small screens.
 *
 * @param {object} props
 * @param {string} props.brand Name shown at the left of the desktop pill.
 * @param {Array<{ to?: string, key?: string, icon: React.ElementType, label: string, end?: boolean, adminOnly?: boolean, children?: import("../../hooks/useNavGroup.js").NavGroupChild[] }>} props.items
 *   An item with `children` is a group (see NavGroup.jsx): one pill that unfolds its sub-pages on hover.
 *   Navigation entries in order. `Alt+Shift+<position>` jumps to each visible one.
 * @param {{ username?: string, display_name?: string, role?: string } | null | undefined} props.user The signed-in person.
 * @param {() => unknown} props.onLogout Called from "Sign out".
 * @param {{ to: string, icon: React.ElementType, label: string, adminOnly?: boolean }[]} [props.menuItems]
 *   Extra links at the top of the desktop user menu.
 * @param {string} props.storageKey localStorage key remembering where the mobile button was parked.
 * @param {boolean} [props.showShortcutsHint] Show "Press ? for keyboard shortcuts" in the user menu. Default true.
 * @param {string} [props.editorKey] `document.documentElement.dataset` key an app sets while a
 *   fullscreen editor is open; the mobile button then hides unless parked in the top strip.
 */
export default function Navbar({ brand, items, user, onLogout, menuItems = [], storageKey, editorKey, showShortcutsHint = true }) {
  const logout = onLogout;
  const isAdmin = user?.role === "admin";
  const shortcutsSheet = useShortcutsSheet();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const firstNavLinkRef = useRef(null);
  const dialogRef = useRef(null);
  const userMenuRef = useRef(null);
  const userMenuPointerRef = useRef("");
  const userTriggerRef = useRef(null);
  // Which item a keyboard open should land on, once the menu is interactive.
  const focusMenuItemRef = useRef(/** @type {"first" | "last" | null} */ (null));
  const mobileMenuId = "mobile-nav-menu";

  const [position, setPosition] = useState({ x: null, y: null });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hasMoved, setHasMoved] = useState(false);
  const animationFrameRef = useRef(null);
  const pendingPositionRef = useRef(null);

  // The app marks documentElement[data-<editorKey>] while a fullscreen
  // editor overlay is mounted; the FAB floats above that overlay, so it must
  // hide — except when parked inside the headerbar strip.
  const [editorOpen, setEditorOpen] = useState(
    () => Boolean(editorKey && document.documentElement.dataset[editorKey]),
  );
  const editorOpenRef = useRef(editorOpen);
  editorOpenRef.current = editorOpen;

  useEffect(() => {
    if (!editorKey) return undefined;
    const observer = new MutationObserver(() => {
      setEditorOpen(Boolean(document.documentElement.dataset[editorKey]));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [`data-${editorKey.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`],
    });
    return () => observer.disconnect();
  }, [editorKey]);

  useEffect(() => {
    const savedPosition = localStorage.getItem(storageKey);
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
        // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
        setPosition(parsed);
      } else {
        localStorage.removeItem(storageKey);
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
          localStorage.removeItem(storageKey);
          setPosition({ x: null, y: null });
        }
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [position]);

  const handleDragStart = (e) => {
    if (window.innerWidth >= 1280 || e.button !== 0) return;

    // Pointer capture keeps the drag alive over iframes — the EuroOffice
    // editor swallows document-level mouse/touch events otherwise.
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const clientX = e.clientX;
    const clientY = e.clientY;

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

  const positionRef = useRef(position);
  positionRef.current = position;
  const dragStartRef = useRef(dragStart);
  dragStartRef.current = dragStart;
  const hasMovedRef = useRef(hasMoved);
  hasMovedRef.current = hasMoved;

  const handleDrag = (e) => {
    if (!isDragging || window.innerWidth >= 1280) return;

    const clientX = e.clientX;
    const clientY = e.clientY;

    let newX = clientX - dragStartRef.current.x;
    let newY = clientY - dragStartRef.current.y;

    const moveThreshold = 12;
    const deltaX = Math.abs(newX - (positionRef.current.x ?? 0));
    const deltaY = Math.abs(newY - (positionRef.current.y ?? 0));

    if (!hasMovedRef.current) {
      if (deltaX > moveThreshold || deltaY > moveThreshold) {
        setHasMoved(true);
      } else {
        return;
      }
    }

    e.preventDefault();

    newX = Math.max(0, Math.min(newX, window.innerWidth - FAB_SIZE));
    newY = Math.max(0, Math.min(newY, window.innerHeight - FAB_SIZE));
    // While the editor is open the FAB is confined to the headerbar strip.
    if (editorOpenRef.current) {
      newY = Math.min(newY, EDITOR_HEADERBAR_HEIGHT);
    }

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

    if (!hasMovedRef.current) {
      return;
    }

    const currentX = positionRef.current.x !== null ? positionRef.current.x : window.innerWidth - 80;
    const currentY = positionRef.current.y !== null ? positionRef.current.y : window.innerHeight - 80;

    const snap = getSnapPosition(
      currentX,
      currentY,
      window.innerWidth,
      window.innerHeight,
    );

    haptic("rigid");
    setPosition(snap);
    localStorage.setItem(storageKey, JSON.stringify(snap));
  };

  useEffect(() => {
    if (isDragging) {
      const handlePointerMove = (e) => handleDrag(e);
      const handlePointerEnd = () => handleDragEnd();

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerEnd);
      document.addEventListener("pointercancel", handlePointerEnd);

      return () => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerEnd);
        document.removeEventListener("pointercancel", handlePointerEnd);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // A keyboard open waits for the menu to stop being inert, then lands on an item.
  useEffect(() => {
    if (!isUserMenuOpen || !focusMenuItemRef.current) return;
    const which = focusMenuItemRef.current;
    focusMenuItemRef.current = null;
    const items = userMenuItems();
    (which === "last" ? items.at(-1) : items[0])?.focus();
  }, [isUserMenuOpen]);

  /** The user menu's items, in order. */
  function userMenuItems() {
    return [...(userMenuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];
  }

  // Arrow keys move through the menu (and open it from the trigger); Escape
  // closes it and puts focus back on the trigger.
  const handleUserMenuKeyDown = (event) => {
    if (event.key === "Escape") {
      if (!isUserMenuOpen) return;
      setIsUserMenuOpen(false);
      userTriggerRef.current?.focus();
      return;
    }
    const isNav = ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key);
    if (!isNav) return;
    const toEnd = event.key === "ArrowUp" || event.key === "End";
    if (event.target.closest?.('[aria-haspopup="menu"]')) {
      event.preventDefault();
      if (!isUserMenuOpen) {
        focusMenuItemRef.current = toEnd ? "last" : "first";
        setIsUserMenuOpen(true);
      } else {
        const items = userMenuItems();
        (toEnd ? items.at(-1) : items[0])?.focus();
      }
      return;
    }
    const items = userMenuItems();
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (at + 1) % items.length
      : (at - 1 + items.length) % items.length;
    items[next].focus();
  };

  // The user menu opens on mouse hover; touch and keyboard toggle it by click.
  // Close it on outside click or Escape.
  useEffect(() => {
    if (!isUserMenuOpen) return;
    const onPointerDown = (e) => {
      if (!userMenuRef.current?.contains(e.target)) {
        setIsUserMenuOpen(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setIsUserMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isUserMenuOpen]);

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

  const closeMobileMenu = () => {
    haptic("light");
    setIsMobileMenuOpen(false);
    menuButtonRef.current?.focus();
  };

  // In the fullscreen editor the FAB is suppressed unless it is parked in
  // the headerbar strip — anything lower overlaps the sidebar/document.
  const fabHidden =
    editorOpen && !(position.y !== null && position.y <= EDITOR_HEADERBAR_HEIGHT);

  const visibleNav = useMemo(
    () => items.filter((item) => !item.adminOnly || isAdmin),
    [items, isAdmin],
  );

  const navButtonsElements = useMemo(
    () =>
      visibleNav.map((item, index) => (
        <React.Fragment key={`desktopNav-${navKey(item)}`}>
          {item.children ? (
            <DesktopNavGroup
              group={/** @type {import("../../hooks/useNavGroup.js").NavGroupItem} */ (item)}
              closedClassName={navButtonClasses}
              keyShortcut={`Alt+Shift+${index + 1}`}
            />
          ) : (
          <NavLink
            to={item.to}
            end={item.end}
            aria-keyshortcuts={`Alt+Shift+${index + 1}`}
            className={navButtonClasses}
            onClick={() => haptic("selection")}
          >
            <item.icon size={ICON_SIZE.lg} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
          )}
        </React.Fragment>
      )),
    [visibleNav],
  );

  return (
    <div data-slot="navbar">
      {visibleNav.slice(0, 9).map((item, index) => (
        item.children ? (
          <NavGroupShortcut key={navKey(item)} item={item} position={index + 1} enabled={!editorOpen} />
        ) : (
          <NavShortcut key={navKey(item)} item={item} position={index + 1} enabled={!editorOpen} />
        )
      ))}
      <div className="hidden xl:flex">
        <nav
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 min-w-screen pl-6 pr-6"
          aria-label="Primary"
        >
          <div className="surface-secondary rounded-pill px-3 py-3 ring-2 ring-accent flex items-center gap-6">
            <span className="font-mono px-3 py-1.5 flex items-center">
              {brand}
            </span>
            <div className="flex items-center gap-6 text-sm font-sans justify-center flex-1">
              {navButtonsElements}
            </div>
            <div
              className="group flex items-center gap-2 relative"
              ref={userMenuRef}
              onKeyDown={handleUserMenuKeyDown}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") setIsUserMenuOpen(true);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") setIsUserMenuOpen(false);
              }}
            >
              <button
                type="button"
                className={cn("font-semibold", "text-sm", "inline-block", "min-w-[6ch]", "max-w-[18ch]", "truncate", "text-right", TRANSITION.full, (user?.display_name || user?.username) ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1", "translate-y-[-0.5px]")}
                aria-label="User menu"
                aria-haspopup="menu"
                aria-expanded={isUserMenuOpen}
                onPointerDown={(e) => {
                  userMenuPointerRef.current = e.pointerType;
                }}
                onClick={() => {
                  haptic("light");
                  // A keyboard click (no pointer) that opens the menu lands on its first item.
                  if (userMenuPointerRef.current === "" && !isUserMenuOpen) focusMenuItemRef.current = "first";
                  // A mouse click lands while hover already opened the menu, so keep it open.
                  if (userMenuPointerRef.current === "mouse") setIsUserMenuOpen(true);
                  else setIsUserMenuOpen((v) => !v);
                  userMenuPointerRef.current = "";
                }}
              >
                {user?.display_name || user?.username || ""}
              </button>
              <button
                ref={userTriggerRef}
                type="button"
                className={cn("h-8", "w-8", "rounded-full", "surface-primary", "flex", "items-center", "justify-center", TRANSITION.full, "focus-visible:ring-3", "focus-visible:ring-accent")}
                aria-label="User menu"
                aria-haspopup="menu"
                aria-expanded={isUserMenuOpen}
                onPointerDown={(e) => {
                  userMenuPointerRef.current = e.pointerType;
                }}
                onClick={() => {
                  haptic("light");
                  // A keyboard click (no pointer) that opens the menu lands on its first item.
                  if (userMenuPointerRef.current === "" && !isUserMenuOpen) focusMenuItemRef.current = "first";
                  // A mouse click lands while hover already opened the menu, so keep it open.
                  if (userMenuPointerRef.current === "mouse") setIsUserMenuOpen(true);
                  else setIsUserMenuOpen((v) => !v);
                  userMenuPointerRef.current = "";
                }}
              >
                <User size={ICON_SIZE.md} aria-hidden="true" />
              </button>

              <div
                role="menu"
                aria-label="User menu"
                // Closed means out of the tab order and the accessibility tree, not just invisible.
                inert={!isUserMenuOpen}
                className={cn("absolute", "bottom-0", "right-0", "pb-16", "opacity-0", "pointer-events-none", isUserMenuOpen && "opacity-100 pointer-events-auto", TRANSITION.full)}
              >
                <div
                  className={cn("surface-secondary", "rounded-large-element", "ring-2", "ring-accent", "px-4", "py-3", "flex", "flex-col", "gap-2", "min-w-48", "translate-y-2", isUserMenuOpen && "translate-y-0", TRANSITION.full)}
                >
                  {menuItems
                    .filter((item) => !item.adminOnly || isAdmin)
                    .map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        role="menuitem"
                        onClick={() => {
                          haptic("selection");
                          setIsUserMenuOpen(false);
                        }}
                        className={cn(menuItemClasses, "hover:bg-primary", "hover:text-secondary")}
                      >
                        <item.icon size={ICON_SIZE.md} aria-hidden="true" />
                        <span className="text-sm font-semibold">{item.label}</span>
                      </NavLink>
                    ))}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      haptic("medium");
                      setIsUserMenuOpen(false);
                      await logout();
                    }}
                    className={cn(menuItemClasses, "hover:bg-primary", "hover:text-secondary", "text-left")}
                  >
                    <X size={ICON_SIZE.md} aria-hidden="true" />
                    <span className="text-sm font-semibold">Sign out</span>
                  </button>
                  {shortcutsSheet && showShortcutsHint && (
                    <p className="px-3 pt-1 text-sm">Press ? for keyboard shortcuts</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </nav>
      </div>

      {!fabHidden && (
      <button
        ref={menuButtonRef}
        type="button"
        className={cn("xl:hidden", "fixed", "bottom-5", "right-5", "flex", "flex-col", "justify-center", "items-center", "w-[60px]", "h-[60px]", "surface-secondary", "border-2", "border-accent", "rounded-full", "cursor-grab", "p-0", "z-[1001]", "touch-none", "select-none", isDragging ? "cursor-grabbing scale-105 transition-none" : "transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]", isMobileMenuOpen ? "active" : "")}
        style={getHamburgerStyle()}
        onClick={() => {
          if (!hasMovedRef.current) {
            haptic("light");
            setIsMobileMenuOpen(!isMobileMenuOpen);
          }
        }}
        onPointerDown={handleDragStart}
        aria-label="Toggle menu"
        aria-expanded={isMobileMenuOpen}
        aria-controls={mobileMenuId}
      >
        <span className={cn("absolute", "w-6", "h-[3px]", "surface-primary", "rounded-full", "transition-[translate,rotate,scale,opacity]", "duration-400", "ease-[cubic-bezier(0.34,1.56,0.64,1)]", isMobileMenuOpen ? "translate-y-0 rotate-45" : "-translate-y-2")} />
        <span className={cn("absolute", "w-6", "h-[3px]", "surface-primary", "rounded-full", "transition-[translate,rotate,scale,opacity]", "duration-400", "ease-[cubic-bezier(0.34,1.56,0.64,1)]", isMobileMenuOpen ? "opacity-0 scale-0" : "opacity-100 scale-100")} />
        <span className={cn("absolute", "w-6", "h-[3px]", "surface-primary", "rounded-full", "transition-[translate,rotate,scale,opacity]", "duration-400", "ease-[cubic-bezier(0.34,1.56,0.64,1)]", isMobileMenuOpen ? "translate-y-0 -rotate-45" : "translate-y-2")} />
      </button>
      )}

      <button
        type="button"
        className={cn("fixed", "inset-0", TRANSITION.base, "bg-secondary/60", "backdrop-blur-sm", "z-999", isMobileMenuOpen ? "opacity-100" : "opacity-0 pointer-events-none")}
        onClick={() => {
          haptic("light");
          closeMobileMenu();
        }}
        aria-label="Close navigation menu"
        aria-hidden={!isMobileMenuOpen}
        tabIndex={isMobileMenuOpen ? 0 : -1}
      />

      <dialog
        id={mobileMenuId}
        ref={dialogRef}
        className={cn("fixed", "top-1/2", "-translate-y-1/2", "left-1/2", "-translate-x-1/2", "z-2000", "xl:hidden", "bg-transparent", TRANSITION.full, isMobileMenuOpen ? "opacity-100 visible scale-100" : "opacity-0 invisible scale-95")}
        open
        aria-modal="true"
        role="dialog"
        aria-label="Primary navigation"
      >
        <nav
          className="flex flex-col w-[82vw] max-w-xs relative surface-secondary rounded-large-element ring-2 ring-accent"
          aria-label="Primary"
        >
          <div className="p-2.5 gap-1 flex flex-col">
            {visibleNav.map((item, index) => (
              <React.Fragment key={`mobileNav-${navKey(item)}`}>
                {item.children ? (
                  <MobileNavGroup
                    group={/** @type {import("../../hooks/useNavGroup.js").NavGroupItem} */ (item)}
                    itemClassName={mobileMenuItemClasses}
                    onNavigate={closeMobileMenu}
                  />
                ) : (
                <NavLink
                  to={item.to}
                  end={item.end}
                  aria-keyshortcuts={`Alt+Shift+${index + 1}`}
                  className={mobileMenuItemClasses}
                  onClick={() => {
                    haptic("selection");
                    closeMobileMenu();
                  }}
                  ref={index === 0 ? firstNavLinkRef : null}
                >
                  <item.icon size={ICON_SIZE.lg} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
                )}
              </React.Fragment>
            ))}
            <div className="mx-4 my-1 h-px bg-accent" aria-hidden="true" />
            <button
              type="button"
              onClick={async () => {
                haptic("medium");
                closeMobileMenu();
                await logout();
              }}
              className={mobileMenuItemClasses}
            >
              <X size={ICON_SIZE.lg} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </nav>
      </dialog>
    </div>
  );
}
