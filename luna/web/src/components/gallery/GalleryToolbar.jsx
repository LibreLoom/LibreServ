import PropTypes from "prop-types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CalendarDays,
  Check,
  Filter,
  Keyboard,
  LayoutGrid,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";
import SegmentedControl from "../common/SegmentedControl";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";

function useIsDesktop() {
  const read = () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia("(min-width: 768px)").matches;
  };
  const [desktop, setDesktop] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", mq.matches !== undefined ? onChange : onChange);
  }, []);
  return desktop;
}

const pillShell =
  "flex items-center gap-1 bg-secondary text-primary rounded-pill p-1 border-2 border-primary/20 focus-within:border-accent transition-colors";

const searchFieldShell =
  "relative flex-1 min-w-0 bg-primary text-secondary rounded-pill motion-safe:transition-[flex-grow,width] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)]";

const searchInputClass =
  "w-full pl-11 pr-9 py-2 bg-transparent text-secondary placeholder:text-accent focus:outline-none no-focus-outline font-mono text-sm";

/**
 * @param {{
 *   id: string,
 *   value: string,
 *   onChange: (e: any) => void,
 *   placeholder: string,
 *   className?: string,
 *   onClear?: () => void,
 * }} props
 */
function GallerySearchInput({
  id,
  value,
  onChange,
  placeholder,
  className,
  onClear,
}) {
  return (
    <div className={cn(searchFieldShell, className)}>
      <Search
        size={18}
        className="absolute left-4 top-1/2 -translate-y-1/2 text-accent pointer-events-none"
        aria-hidden="true"
      />
      <input
        id={id}
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            haptic("light");
            if (onClear) onClear();
            else onChange({ target: { value: "" } });
          }
        }}
        aria-label="Search photos"
        className={searchInputClass}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-accent hover:text-secondary rounded-pill transition-colors"
          onClick={() => {
            haptic("light");
            if (onClear) onClear();
            else onChange({ target: { value: "" } });
          }}
        >
          <X size={15} />
        </button>
      ) : null}
    </div>
  );
}

GallerySearchInput.propTypes = {
  id: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  placeholder: PropTypes.string.isRequired,
  className: PropTypes.string,
  onClear: PropTypes.func,
};

/**
 * Photos navigation bar:
 * - On large screens (desktop): unified single bar with search, actions, and category segments.
 * - On small screens (mobile): splits apart into two bars — search bar on top, category bar below it.
 *
 * @param {{
 *   segments: Array<{value:string,label:string}>,
 *   segment: string,
 *   onSegmentChange: (v: string) => void,
 *   query: string,
 *   onQueryChange: (e: any) => void,
 *   searchOpen?: boolean,
 *   onSearchOpenChange?: (open: boolean) => void,
 *   selectMode?: boolean,
 *   onSelectModeChange?: (on: boolean) => void,
 *   onOpenDates?: () => void,
 *   onOpenFilters?: () => void,
 *   filterActiveCount?: number,
 *   columns?: number,
 *   onColumnsChange?: (n: number) => void,
 *   showSelect?: boolean,
 *   onRescan?: () => (void | Promise<unknown>),
 *   rescanPending?: boolean,
 *   onOpenShortcuts?: () => void,
 *   isDesktop?: boolean,
 * }} props
 */
export default function GalleryToolbar({
  segments,
  segment,
  onSegmentChange,
  query,
  onQueryChange,
  selectMode = false,
  onSelectModeChange,
  onOpenDates,
  onOpenFilters,
  filterActiveCount = 0,
  columns = 6,
  onColumnsChange,
  showSelect = true,
  onRescan,
  rescanPending = false,
  onOpenShortcuts,
  isDesktop: isDesktopProp,
}) {
  const isDesktopAuto = useIsDesktop();
  const isDesktop = isDesktopProp !== undefined ? isDesktopProp : isDesktopAuto;
  const [moreOpen, setMoreOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const moreButtonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const portalRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const [rescanState, setRescanState] = useState("idle");
  const rescanTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));

  const handleRescan = useCallback(async () => {
    haptic("medium");
    try {
      await onRescan?.();
      setRescanState("success");
    } catch {
      setRescanState("error");
    }
    if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
    rescanTimerRef.current = setTimeout(() => setRescanState("idle"), 2400);
  }, [onRescan]);

  useEffect(
    () => () => {
      if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
    },
    []
  );

  const closeMore = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setMoreOpen(false);
      setIsClosing(false);
    }, 160);
  }, []);

  const updateMenuPosition = useCallback(() => {
    if (moreButtonRef.current) {
      const rect = moreButtonRef.current.getBoundingClientRect();
      const menuWidth = 220;
      let left = rect.right + window.scrollX - menuWidth;
      if (left + menuWidth > window.innerWidth - 12) {
        left = window.innerWidth - menuWidth - 12;
      }
      if (left < 12) left = 12;
      const top = rect.bottom + window.scrollY + 6;
      setMenuPosition({ top, left });
    }
  }, []);

  useEffect(() => {
    if (!moreOpen) return undefined;
    function onDocClick(e) {
      if (
        moreButtonRef.current?.contains(e.target) ||
        portalRef.current?.contains(e.target)
      ) {
        return;
      }
      closeMore();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") {
        // A dialog opened from this menu (Jump to date, shortcuts) owns
        // Escape while it is open — closing the menu here would also yank
        // focus back to the trigger underneath the modal.
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        haptic("light");
        closeMore();
        moreButtonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", updateMenuPosition, true);
    window.addEventListener("resize", updateMenuPosition);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", updateMenuPosition, true);
      window.removeEventListener("resize", updateMenuPosition);
    };
  }, [moreOpen, closeMore, updateMenuPosition]);

  useLayoutEffect(() => {
    if (moreOpen) {
      updateMenuPosition();
    }
  }, [moreOpen, updateMenuPosition]);

  const rescanPhase = rescanPending ? "pending" : rescanState;
  const [rescanLeaving, setRescanLeaving] = useState(/** @type {string|null} */ (null));
  const rescanPhaseRef = useRef(rescanPhase);
  // When the phase changes, keep the outgoing state mounted for one swap
  // animation so the old icon + label can slide out instead of vanishing.
  if (rescanPhaseRef.current !== rescanPhase) {
    setRescanLeaving(rescanPhaseRef.current);
    rescanPhaseRef.current = rescanPhase;
  }

  useEffect(() => {
    if (!rescanLeaving) return undefined;
    const t = setTimeout(() => setRescanLeaving(null), 240);
    return () => clearTimeout(t);
  }, [rescanLeaving]);

  const rescanReturning = rescanLeaving === "success" || rescanLeaving === "error";
  const hasSelect = Boolean(showSelect && onSelectModeChange);
  const selectButton = (
    <div
      data-slot="gallery-select-wrapper"
      className={cn(
        "grid shrink-0 min-w-0",
        "motion-safe:transition-[grid-template-columns,opacity] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)]",
        hasSelect
          ? "grid-cols-[1fr] opacity-100"
          : "grid-cols-[0fr] opacity-0 pointer-events-none"
      )}
      aria-hidden={!hasSelect}
    >
      {/* overflow-x-clip only: a y-clip would cut the focus ring; px-1 gives
          the ring room so it isn't clipped on the sides either. */}
      <div className="min-w-0 overflow-x-clip px-1">
        <Button
          type="button"
          size="sm"
          variant={selectMode ? "accent" : "ghost"}
          className="shrink-0 whitespace-nowrap"
          tabIndex={hasSelect ? 0 : -1}
          onClick={() => {
            haptic("selection");
            onSelectModeChange?.(!selectMode);
          }}
        >
          {selectMode ? "Cancel" : "Select"}
        </Button>
      </div>
    </div>
  );

  const iconButtons = (
    <div className="flex items-center shrink-0 pr-0.5">
      {onOpenFilters && (
        <Button
          type="button"
          size={filterActiveCount > 0 ? "sm" : "iconSm"}
          variant={filterActiveCount > 0 ? "primary" : "ghost"}
          surface="secondary"
          className={cn(
            "group shrink-0",
            filterActiveCount > 0 && "gap-1.5 pl-2.5 pr-1.5",
          )}
          aria-label={
            filterActiveCount > 0
              ? `Filters, ${filterActiveCount} active`
              : "Filters"
          }
          onClick={() => {
            haptic("light");
            onOpenFilters();
          }}
        >
          <Filter size={16} />
          {filterActiveCount > 0 && (
            <span
              className="inline-flex min-w-[1.125rem] h-[1.125rem] px-1 items-center justify-center rounded-pill bg-secondary text-primary group-hover:bg-primary group-hover:text-secondary text-[10px] font-mono leading-none transition-colors"
              aria-hidden="true"
            >
              {filterActiveCount > 9 ? "9+" : filterActiveCount}
            </span>
          )}
        </Button>
      )}
      {selectButton}
      <div className="pl-0.5 shrink-0">
        <Button
          ref={moreButtonRef}
          type="button"
          size="iconSm"
          variant={moreOpen ? "accent" : "ghost"}
          className="shrink-0"
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => {
            haptic("light");
            if (moreOpen) {
              closeMore();
            } else {
              updateMenuPosition();
              setMoreOpen(true);
            }
          }}
        >
          <MoreHorizontal size={16} />
        </Button>
      </div>
    </div>
  );

  const clearQuery = () => {
    onQueryChange({ target: { value: "" } });
  };

  const rescanContent = (/** @type {string} */ phase) => (
    <>
      {phase === "success" ? (
        <Check size={15} className="shrink-0 text-success" aria-hidden="true" />
      ) : phase === "error" ? (
        <X size={15} className="shrink-0 text-error" aria-hidden="true" />
      ) : (
        <RefreshCw
          size={15}
          className={cn("shrink-0 text-accent", phase === "pending" && "animate-spin")}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          phase === "success" && "text-success",
          phase === "error" && "text-error"
        )}
      >
        {phase === "success"
          ? "Started scan."
          : phase === "error"
            ? "Failed to start"
            : phase === "pending"
              ? "Rescanning drives…"
              : "Rescan drives"}
      </span>
    </>
  );

  const moreMenuPortal = moreOpen
    ? createPortal(
        <div
          ref={portalRef}
          role="menu"
          aria-label="More options"
          tabIndex={-1}
          style={{
            position: "absolute",
            top: menuPosition.top,
            left: menuPosition.left,
          }}
          className={cn(
            "bg-secondary text-primary font-mono ring-2 ring-accent",
            "rounded-large-element py-1.5 z-50 min-w-[14rem] shadow-xl",
            isClosing ? "animate-dropdown-close" : "animate-dropdown-open"
          )}
        >
          {onColumnsChange && (
            <div className="px-2 pt-1 pb-1.5">
              <div className="flex items-center gap-1.5 px-2 pb-1.5 text-xs font-mono text-primary">
                <LayoutGrid size={13} className="shrink-0" aria-hidden="true" />
                <span>Grid density</span>
              </div>
              <SegmentedControl
                options={[3, 4, 5, 6].map((n) => ({
                  value: String(n),
                  label: String(n),
                  title: `${n} columns`,
                }))}
                value={String(columns)}
                onChange={(value) => onColumnsChange(Number(value))}
                surface="secondary"
                aria-label="Grid density columns"
                className="w-full"
              />
            </div>
          )}

          {onColumnsChange && (onOpenDates || onRescan || onOpenShortcuts) && (
            <div className="my-1 h-px bg-primary/10 mx-2" aria-hidden="true" />
          )}

          <div className="px-1 space-y-0.5">
            {onOpenDates && (
              <button
                type="button"
                role="menuitem"
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-pill text-xs font-mono text-left cursor-pointer transition-colors hover:bg-primary hover:text-secondary active:scale-[0.98]"
                onClick={() => {
                  haptic("light");
                  setMoreOpen(false);
                  setIsClosing(false);
                  onOpenDates();
                }}
              >
                <CalendarDays size={15} className="shrink-0 text-accent" aria-hidden="true" />
                <span>Jump to date</span>
              </button>
            )}

            {onRescan && (
              <button
                type="button"
                role="menuitem"
                disabled={rescanPhase !== "idle"}
                aria-live="polite"
                className="relative overflow-hidden w-full flex items-center gap-2.5 px-3 py-2 rounded-pill text-xs font-mono text-left cursor-pointer transition-colors enabled:hover:bg-primary enabled:hover:text-secondary enabled:active:scale-[0.98] disabled:cursor-not-allowed"
                onClick={handleRescan}
              >
                {/* Conveyor swap: the outgoing icon + label stay mounted for one
                    animation and slide out through the row's clipped top edge
                    while the incoming pair rises from the bottom; returning to
                    "Rescan drives" rolls the other way. The enter animation only
                    runs when a previous state is leaving, so opening the menu
                    doesn't replay it. */}
                <span
                  key={rescanPhase}
                  className={cn(
                    "flex items-center gap-2.5",
                    rescanLeaving &&
                      (rescanReturning
                        ? "animate-rescan-swap-in-back"
                        : "animate-rescan-swap-in")
                  )}
                >
                  {rescanContent(rescanPhase)}
                </span>
                {rescanLeaving && (
                  <span
                    className="absolute inset-x-3 inset-y-0 flex items-center pointer-events-none"
                    aria-hidden="true"
                  >
                    <span
                      className={cn(
                        "flex items-center gap-2.5",
                        rescanReturning
                          ? "animate-rescan-swap-out-back"
                          : "animate-rescan-swap-out"
                      )}
                    >
                      {rescanContent(rescanLeaving)}
                    </span>
                  </span>
                )}
              </button>
            )}

            {onOpenShortcuts && (
              <button
                type="button"
                role="menuitem"
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-pill text-xs font-mono text-left cursor-pointer transition-colors hover:bg-primary hover:text-secondary active:scale-[0.98]"
                onClick={() => {
                  haptic("light");
                  setMoreOpen(false);
                  setIsClosing(false);
                  onOpenShortcuts();
                }}
              >
                <Keyboard size={15} className="shrink-0 text-accent" aria-hidden="true" />
                <span>Keyboard shortcuts</span>
              </button>
            )}
          </div>
        </div>,
        document.body
      )
    : null;

  if (isDesktop) {
    return (
      <div data-slot="gallery-toolbar" className="mb-6 space-y-3">
        <div className={cn(pillShell, "flex items-center whitespace-nowrap")}>
          <GallerySearchInput
            id="photo-search"
            value={query}
            onChange={onQueryChange}
            placeholder="Search photos…"
            onClear={clearQuery}
          />
          {iconButtons}
          <div className="shrink-0">
            <SegmentedControl
              options={segments}
              value={segment}
              onChange={onSegmentChange}
              surface="secondary"
            />
          </div>
        </div>
        {moreMenuPortal}
      </div>
    );
  }

  return (
    <div data-slot="gallery-toolbar" className="mb-6 space-y-3">
      {/* Top bar on small screens: Search bar + actions */}
      <div className={cn(pillShell, "flex items-center")}>
        <GallerySearchInput
          id="photo-search-mobile"
          value={query}
          onChange={onQueryChange}
          placeholder="Search photos…"
          onClear={clearQuery}
        />
        {iconButtons}
      </div>

      {/* Bottom bar on small screens: Category bar below the search bar */}
      <div className={cn(pillShell, "justify-center")}>
        <SegmentedControl
          options={segments}
          value={segment}
          onChange={onSegmentChange}
          surface="secondary"
          className="w-full"
        />
      </div>
      {moreMenuPortal}
    </div>
  );
}

GalleryToolbar.propTypes = {
  segments: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
    }),
  ).isRequired,
  segment: PropTypes.string.isRequired,
  onSegmentChange: PropTypes.func.isRequired,
  query: PropTypes.string.isRequired,
  onQueryChange: PropTypes.func.isRequired,
  searchOpen: PropTypes.bool,
  onSearchOpenChange: PropTypes.func,
  selectMode: PropTypes.bool,
  onSelectModeChange: PropTypes.func,
  onOpenDates: PropTypes.func,
  onOpenFilters: PropTypes.func,
  filterActiveCount: PropTypes.number,
  columns: PropTypes.number,
  onColumnsChange: PropTypes.func,
  showSelect: PropTypes.bool,
  onRescan: PropTypes.func,
  rescanPending: PropTypes.bool,
  onOpenShortcuts: PropTypes.func,
  isDesktop: PropTypes.bool,
};
