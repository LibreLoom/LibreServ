import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Folder, HardDrive } from "lucide-react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
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

const DEST_ICONS = { folder: Folder, drive: HardDrive };

/**
 * Drive menu — Luna's destination picker in the Files page header, built on
 * the shared Dropdown in menu mode. The trigger shows the place being browsed;
 * opening it lists every OTHER destination as a menu item that navigates
 * there. For admins the destinations are whole drives; for members they
 * are the shared folders they can write to, since members can't address a
 * drive's unrestricted root.
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
 *   destinations?: Array<{ driveId: string, path: string, label: string, sub?: string, icon?: "folder"|"drive", writable?: boolean }>,
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
    return /** @type {{ driveId: string, path: string, label: string, sub?: string, icon?: "folder"|"drive", writable?: boolean }[]} */ (
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

  const [open, setOpen] = useState(false);
  const [dragOverDriveId, setDragOverDriveId] = useState(/** @type {string|null} */ (null));
  const openTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const springTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const springTargetRef = useRef(/** @type {string|null} */ (null));

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

  const handleOpenChange = useCallback(
    (next) => {
      setOpen(next);
      if (!next) clearDragTimers();
    },
    [clearDragTimers],
  );

  // Timers must not outlive the component.
  useEffect(() => () => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (springTimerRef.current) clearTimeout(springTimerRef.current);
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

  function destKey(dest) {
    return `${dest.driveId}:${dest.path || ""}`;
  }

  // Drag-over the trigger arms the auto-open delay. The trigger itself is
  // not a drop target — no preventDefault, so a drop here is rejected and
  // the drag moves on to a real target.
  function handleTriggerDragOver(event) {
    if (!hasLunaPaths(event) || open || openTimerRef.current) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, DRIVE_MENU_OPEN_MS);
  }

  function handleTriggerDragLeave(event) {
    if (event.currentTarget.contains(/** @type {Node|null} */ (event.relatedTarget))) return;
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
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
      handleOpenChange(false);
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
    handleOpenChange(false);
  }

  const options = useMemo(
    () =>
      otherItems.map((d) => ({
        value: destKey(d),
        label: d.label,
        sub: d.sub,
        icon: DEST_ICONS[d.icon] || Folder,
      })),
    [otherItems],
  );

  if (otherItems.length < 1) return null;

  const triggerLabel = currentLabel || current?.label;

  return (
    <Dropdown
      menu
      menuLabel="Places"
      options={options}
      value=""
      open={open}
      onOpenChange={handleOpenChange}
      onChange={(key) => {
        const dest = otherItems.find((d) => destKey(d) === key);
        if (dest) navigate(folderHref(dest.driveId, dest.path || ""));
      }}
      optionProps={(option) => {
        const dest = otherItems.find((d) => destKey(d) === option.value);
        if (!dest) return undefined;
        const canDrop = dest.writable !== false;
        return {
          className: dragOverDriveId === option.value ? "ring-2 ring-inset ring-accent" : undefined,
          onDragOver: (e) => handleItemDragOver(dest, canDrop, e),
          onDragLeave: (e) => handleItemDragLeave(dest, e),
          onDrop: (e) => handleItemDrop(dest, canDrop, e),
        };
      }}
      renderTrigger={({ open: isOpen, toggle, onKeyDown }) => (
        <span
          className="inline-flex"
          onDragOver={handleTriggerDragOver}
          onDragLeave={handleTriggerDragLeave}
        >
          <Button
            variant="outline"
            surface="secondary"
            size="sm"
            type="button"
            haptic={false}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label={triggerLabel ? `Places: ${triggerLabel}` : "Places"}
            onClick={toggle}
            onKeyDown={onKeyDown}
          >
            <HardDrive size={ICON_SIZE.sm} aria-hidden="true" />
            {triggerLabel || "Places"}
            <ChevronDown
              size={ICON_SIZE.sm}
              aria-hidden="true"
              className={cn(
                "motion-safe:transition-transform motion-safe:duration-300",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </Button>
        </span>
      )}
    />
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
