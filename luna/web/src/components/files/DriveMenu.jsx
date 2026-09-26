import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Folder, HardDrive, Home } from "lucide-react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { hasLunaPaths, LUNA_DRIVE_MIME, LUNA_PATHS_MIME, SPRING_LOAD_MS } from "../../lib/dnd.js";
import { isPresentDrive, isWritableDrive } from "../../lib/drives.js";
import { folderHref } from "../../lib/paths.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/**
 * Hover delay before the menu opens itself under an in-flight file drag —
 * long enough that sweeping the cursor past the trigger doesn't pop it.
 */
export const DRIVE_MENU_OPEN_MS = 500;
/**
 * Hover-hold delay on a drive item before it spring-loads that drive —
 * shared with the file browser's folder rows via `SPRING_LOAD_MS`.
 */
export const DRIVE_SPRING_LOAD_MS = SPRING_LOAD_MS;

const DEST_ICONS = { home: Home, folder: Folder, drive: HardDrive };

/**
 * Drive menu — Luna's destination picker in the Files page header, modeled
 * on the NewItemMenu dropdown. The trigger shows the place being browsed;
 * opening it lists every OTHER destination as a menu item that navigates
 * there. For admins the destinations are whole drives; for members they
 * are writable roots — their Home folder and shared roots with write
 * access — since members can't address a drive's unrestricted root.
 * Renders nothing when no other destination exists.
 *
 * Drag and drop, while a file drag carrying `application/x-luna-paths` is
 * in flight:
 *  - Hovering the trigger for DRIVE_MENU_OPEN_MS opens the menu.
 *  - Dropping on a writable destination's item moves the files to that
 *    place WITHOUT navigating — the browser stays on the current folder.
 *  - Hover-holding an item for DRIVE_SPRING_LOAD_MS spring-loads that
 *    destination: the browser navigates to it while the HTML5 drag session
 *    stays alive (it's document-level, not tied to the route), so the
 *    files can then be dropped into a folder inside it. The drag's source
 *    drive travels in `application/x-luna-drive` so the move job posts the
 *    right `from_drive` after the page switches drives.
 *
 * One outline per element: drop-target items draw a single inset accent
 * ring over an accent-tinted fill — never a border stacked with a ring.
 *
 * @param {{
 *   drives?: any[],
 *   destinations?: Array<{ driveId: string, path: string, label: string, sub?: string, icon?: "home"|"folder"|"drive", writable?: boolean }>,
 *   currentDriveId: string,
 *   currentPath?: string,
 *   currentLabel?: string,
 *   onDropPaths: (driveId: string, path: string, paths: string[], sourceDriveId?: string) => void,
 * }} props
 */
export default function DriveMenu({ drives, destinations, currentDriveId, currentPath = "", currentLabel, onDropPaths }) {
  const navigate = useNavigate();
  const items = useMemo(() => {
    if (destinations) return destinations;
    return /** @type {{ driveId: string, path: string, label: string, sub?: string, icon?: "home"|"folder"|"drive", writable?: boolean }[]} */ (
      (drives || [])
        .filter(isPresentDrive)
        .map((d) => ({
          driveId: d.id,
          path: "",
          label: d.label,
          icon: "drive",
          writable: isWritableDrive(d),
        }))
    );
  }, [drives, destinations]);
  const otherItems = useMemo(
    () => items.filter((d) => !(d.driveId === currentDriveId && (d.path || "") === (currentPath || ""))),
    [items, currentDriveId, currentPath],
  );
  const current = items.find((d) => d.driveId === currentDriveId && (d.path || "") === (currentPath || ""));

  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragOverDriveId, setDragOverDriveId] = useState(/** @type {string|null} */ (null));
  const containerRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const portalRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const buttonRef = useRef(/** @type {HTMLSpanElement|null} */ (null));
  const openTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const springTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const springTargetRef = useRef(/** @type {string|null} */ (null));
  const closeTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menuWidth = portalRef.current?.offsetWidth || Math.max(rect.width, 176);
    let left = rect.left + window.scrollX;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    setPosition({ top: rect.bottom + window.scrollY + 4, left });
  }, []);

  const clearDragTimers = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (springTimerRef.current) {
      clearTimeout(springTimerRef.current);
      springTimerRef.current = null;
    }
    springTargetRef.current = null;
    setDragOverDriveId(null);
  }, []);

  const close = useCallback(() => {
    clearDragTimers();
    setIsClosing(true);
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      setActiveIndex(0);
      closeTimerRef.current = null;
    }, 160);
  }, [clearDragTimers]);

  const openMenu = useCallback(() => {
    // Reopening mid-close-animation cancels the pending close.
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    updatePosition();
    setIsClosing(false);
    setIsOpen(true);
  }, [updatePosition]);

  // Timers must not outlive the component.
  useEffect(() => () => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (springTimerRef.current) clearTimeout(springTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  // A drop or dragend anywhere on the document ends the in-flight drag —
  // disarm pending auto-open/spring-load timers so they can't fire late.
  useEffect(() => {
    function onDragSettled() {
      clearDragTimers();
    }
    document.addEventListener("drop", onDragSettled);
    document.addEventListener("dragend", onDragSettled);
    return () => {
      document.removeEventListener("drop", onDragSettled);
      document.removeEventListener("dragend", onDragSettled);
    };
  }, [clearDragTimers]);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handleClickOutside(event) {
      if (containerRef.current?.contains(/** @type {Node|null} */ (event.target))
        || portalRef.current?.contains(/** @type {Node|null} */ (event.target))) return;
      close();
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        close();
        containerRef.current?.querySelector("button")?.focus();
      }
    }
    function handleScroll() {
      updatePosition();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [isOpen, close, updatePosition]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
  }, [isOpen, updatePosition]);

  function pick(dest) {
    haptic("selection");
    navigate(folderHref(dest.driveId, dest.path || ""));
    if (isOpen) close();
  }

  function handleTrigger() {
    if (isOpen) {
      close();
      return;
    }
    openMenu();
  }

  // Drag-over the trigger arms the auto-open delay. The trigger itself is
  // not a drop target — no preventDefault, so a drop here is rejected and
  // the drag moves on to a real target.
  function handleTriggerDragOver(event) {
    if (!hasLunaPaths(event) || isOpen || openTimerRef.current) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      openMenu();
    }, DRIVE_MENU_OPEN_MS);
  }

  function handleTriggerDragLeave(event) {
    if (event.currentTarget.contains(/** @type {Node|null} */ (event.relatedTarget))) return;
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }

  function destKey(dest) {
    return `${dest.driveId}:${dest.path || ""}`;
  }

  function armSpringLoad(dest) {
    const key = destKey(dest);
    if (springTargetRef.current === key) return;
    springTargetRef.current = key;
    setDragOverDriveId(key);
    if (springTimerRef.current) clearTimeout(springTimerRef.current);
    springTimerRef.current = setTimeout(() => {
      springTimerRef.current = null;
      springTargetRef.current = null;
      // Spring-load: navigate mid-drag so the user can drop into a folder
      // inside this destination. The drag session survives the route change.
      haptic("medium");
      navigate(folderHref(dest.driveId, dest.path || ""));
      close();
    }, DRIVE_SPRING_LOAD_MS);
  }

  function handleItemDragOver(dest, canDrop, event) {
    if (!canDrop || !hasLunaPaths(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    armSpringLoad(dest);
  }

  function handleItemDragLeave(dest, event) {
    const key = destKey(dest);
    if (event.currentTarget.contains(/** @type {Node|null} */ (event.relatedTarget))) return;
    if (dragOverDriveId === key) setDragOverDriveId(null);
    if (springTargetRef.current === key) {
      springTargetRef.current = null;
      if (springTimerRef.current) {
        clearTimeout(springTimerRef.current);
        springTimerRef.current = null;
      }
    }
  }

  function handleItemDrop(dest, canDrop, event) {
    if (!canDrop) return;
    event.preventDefault();
    event.stopPropagation();
    clearDragTimers();
    haptic("heavy");
    const raw = event.dataTransfer?.getData(LUNA_PATHS_MIME);
    if (raw) {
      try {
        const paths = JSON.parse(raw);
        if (Array.isArray(paths) && paths.length > 0) {
          const sourceDriveId = event.dataTransfer?.getData(LUNA_DRIVE_MIME) || undefined;
          onDropPaths(dest.driveId, dest.path || "", paths, sourceDriveId);
        }
      } catch {
        // Ignore malformed drag payload.
      }
    }
    if (isOpen) close();
  }

  function handleMenuKeyDown(event) {
    if (!otherItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % otherItems.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + otherItems.length) % otherItems.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const dest = otherItems[activeIndex];
      if (dest) pick(dest);
    }
  }

  if (otherItems.length < 1) return null;

  return (
    <div className="relative inline-flex" ref={containerRef}>
      <span
        ref={buttonRef}
        className="inline-flex"
        onDragOver={handleTriggerDragOver}
        onDragLeave={handleTriggerDragLeave}
      >
        <Button
          variant="outline"
          surface="secondary"
          size="sm"
          type="button"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-label={currentLabel || current ? `Places: ${currentLabel || current?.label}` : "Places"}
          onClick={handleTrigger}
        >
          <HardDrive size={ICON_SIZE.sm} aria-hidden="true" />
          {currentLabel || current?.label || "Places"}
          <ChevronDown
            size={ICON_SIZE.sm}
            aria-hidden="true"
            className={cn(
              "motion-safe:transition-transform motion-safe:duration-300",
              isOpen && !isClosing ? "rotate-180" : "rotate-0",
            )}
          />
        </Button>
      </span>

      {isOpen
        ? createPortal(
          <div
            ref={portalRef}
            role="menu"
            aria-label="Places"
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "bg-secondary text-primary ring-inset ring-2 ring-accent",
              "rounded-large-element z-50 overflow-hidden min-w-[12rem] max-h-72 overflow-y-auto no-scrollbar",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            {otherItems.map((d, index) => {
              const canDrop = d.writable !== false;
              const isDragTarget = dragOverDriveId === destKey(d);
              const Icon = DEST_ICONS[d.icon] || Folder;
              return (
                <button
                  key={destKey(d)}
                  type="button"
                  role="menuitem"
                  className={cn(
                    "w-full flex items-center gap-2 px-4 py-2 text-sm text-left cursor-pointer",
                    "text-primary font-mono motion-safe:transition-all motion-safe:duration-150",
                    isDragTarget
                      ? "bg-accent/20 ring-2 ring-inset ring-accent"
                      : index === activeIndex
                        ? "bg-primary/10 motion-safe:translate-x-0.5"
                        : "hover:bg-primary/10 hover:motion-safe:translate-x-0.5",
                    isClosing ? "" : "animate-dropdown-option",
                  )}
                  style={isClosing ? undefined : { animationDelay: `${index * 45}ms` }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(d)}
                  onDragOver={(e) => handleItemDragOver(d, canDrop, e)}
                  onDragLeave={(e) => handleItemDragLeave(d, e)}
                  onDrop={(e) => handleItemDrop(d, canDrop, e)}
                >
                  <Icon size={ICON_SIZE.sm} aria-hidden="true" className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{d.label}</span>
                    {d.sub ? <span className="block truncate text-xs font-sans text-accent">{d.sub}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

DriveMenu.propTypes = {
  drives: PropTypes.array,
  destinations: PropTypes.array,
  currentDriveId: PropTypes.string.isRequired,
  currentPath: PropTypes.string,
  currentLabel: PropTypes.string,
  onDropPaths: PropTypes.func.isRequired,
};
