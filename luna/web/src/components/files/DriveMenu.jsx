import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ChevronDown, HardDrive } from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button.jsx";
import { cn } from "@/lib/utils";
import { hasLunaPaths, LUNA_DRIVE_MIME, LUNA_PATHS_MIME, SPRING_LOAD_MS } from "../../lib/dnd.js";
import { isPresentDrive, isWritableDrive } from "../../lib/drives.js";
import { ICON_SIZE } from "@/lib/ui-tokens";
import { haptic } from "../../utils/haptics.js";

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

/**
 * Drive menu — Luna's drive picker in the Files page header, modeled on the
 * NewItemMenu dropdown. The trigger shows the drive being browsed; opening
 * it lists every OTHER ready drive as a menu item that navigates to that
 * drive's root. Renders nothing when fewer than two drives are ready.
 *
 * Drag and drop, while a file drag carrying `application/x-luna-paths` is
 * in flight:
 *  - Hovering the trigger for DRIVE_MENU_OPEN_MS opens the menu.
 *  - Dropping on a writable drive's item moves the files to that drive's
 *    root WITHOUT navigating — the browser stays on the current folder.
 *  - Hover-holding an item for DRIVE_SPRING_LOAD_MS spring-loads that
 *    drive: the browser navigates to its root while the HTML5 drag session
 *    stays alive (it's document-level, not tied to the route), so the files
 *    can then be dropped into any folder on that drive. The drag's source
 *    drive travels in `application/x-luna-drive` so the move job posts the
 *    right `from_drive` after the page switches drives.
 *
 * One outline per element: drop-target items draw a single inset accent
 * ring over an accent-tinted fill — never a border stacked with a ring.
 *
 * @param {{
 *   drives?: any[],
 *   currentDriveId: string,
 *   onDropPaths: (driveId: string, paths: string[], sourceDriveId?: string) => void,
 * }} props
 */
export default function DriveMenu({ drives, currentDriveId, onDropPaths }) {
  const navigate = useNavigate();
  const presentDrives = useMemo(
    () => (drives || []).filter(isPresentDrive),
    [drives],
  );
  const otherDrives = useMemo(
    () => presentDrives.filter((d) => d.id !== currentDriveId),
    [presentDrives, currentDriveId],
  );
  const current = presentDrives.find((d) => d.id === currentDriveId);

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

  function pick(drive) {
    haptic("selection");
    navigate(`/drives/${drive.id}`);
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

  function armSpringLoad(drive) {
    if (springTargetRef.current === drive.id) return;
    springTargetRef.current = drive.id;
    setDragOverDriveId(drive.id);
    if (springTimerRef.current) clearTimeout(springTimerRef.current);
    springTimerRef.current = setTimeout(() => {
      springTimerRef.current = null;
      springTargetRef.current = null;
      // Spring-load: navigate mid-drag so the user can drop into a folder
      // on this drive. The drag session survives the route change.
      haptic("medium");
      navigate(`/drives/${drive.id}`);
      close();
    }, DRIVE_SPRING_LOAD_MS);
  }

  function handleItemDragOver(drive, canDrop, event) {
    if (!canDrop || !hasLunaPaths(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    armSpringLoad(drive);
  }

  function handleItemDragLeave(drive, event) {
    if (event.currentTarget.contains(/** @type {Node|null} */ (event.relatedTarget))) return;
    if (dragOverDriveId === drive.id) setDragOverDriveId(null);
    if (springTargetRef.current === drive.id) {
      springTargetRef.current = null;
      if (springTimerRef.current) {
        clearTimeout(springTimerRef.current);
        springTimerRef.current = null;
      }
    }
  }

  function handleItemDrop(drive, canDrop, event) {
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
          onDropPaths(drive.id, paths, sourceDriveId);
        }
      } catch {
        // Ignore malformed drag payload.
      }
    }
    if (isOpen) close();
  }

  function handleMenuKeyDown(event) {
    if (!otherDrives.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % otherDrives.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + otherDrives.length) % otherDrives.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const drive = otherDrives[activeIndex];
      if (drive) pick(drive);
    }
  }

  if (presentDrives.length < 2) return null;

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
          aria-label={current ? `Drives: ${current.label}` : "Drives"}
          onClick={handleTrigger}
        >
          <HardDrive size={ICON_SIZE.sm} aria-hidden="true" />
          {current?.label || "Drives"}
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
            aria-label="Drives"
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "bg-secondary text-primary ring-inset ring-2 ring-accent",
              "rounded-large-element z-50 overflow-hidden min-w-[12rem] max-h-72 overflow-y-auto",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            {otherDrives.map((d, index) => {
              const canDrop = isWritableDrive(d);
              const isDragTarget = dragOverDriveId === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  role="menuitem"
                  className={cn(
                    "w-full flex items-center gap-2 px-4 py-2 text-sm text-left cursor-pointer",
                    "text-primary font-mono motion-safe:transition-all motion-safe:duration-150",
                    isDragTarget
                      ? "bg-accent/20 ring-2 ring-inset ring-accent"
                      : index === activeIndex
                        ? "bg-primary/10"
                        : "hover:bg-primary/10",
                    isClosing ? "" : "animate-dropdown-option",
                  )}
                  style={isClosing ? undefined : { animationDelay: `${index * 45}ms` }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(d)}
                  onDragOver={(e) => handleItemDragOver(d, canDrop, e)}
                  onDragLeave={(e) => handleItemDragLeave(d, e)}
                  onDrop={(e) => handleItemDrop(d, canDrop, e)}
                >
                  <HardDrive size={ICON_SIZE.sm} aria-hidden="true" className="shrink-0 text-accent" />
                  <span className="truncate">{d.label}</span>
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
  currentDriveId: PropTypes.string.isRequired,
  onDropPaths: PropTypes.func.isRequired,
};
