import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Filter,
  MoreHorizontal,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import SegmentedControl from "../common/SegmentedControl";
import Button from "../ui/Button.jsx";
import { haptic } from "../../utils/haptics.js";

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
  "relative flex-1 min-w-0 bg-primary text-secondary rounded-pill";

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
 *   onRescan?: () => void,
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
  const moreRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  useEffect(() => {
    if (!moreOpen) return undefined;
    function onDoc(e) {
      if (moreRef.current && !moreRef.current.contains(e.target)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen]);

  const selectButton =
    showSelect && onSelectModeChange ? (
      <Button
        type="button"
        size="sm"
        variant={selectMode ? "accent" : "ghost"}
        className="shrink-0"
        onClick={() => {
          haptic("selection");
          onSelectModeChange(!selectMode);
        }}
      >
        {selectMode ? "Cancel" : "Select"}
      </Button>
    ) : null;

  const iconButtons = (
    <div className="flex items-center gap-0.5 shrink-0 pr-0.5">
      {onOpenFilters && (
        <Button
          type="button"
          size="iconSm"
          variant={filterActiveCount > 0 ? "accent" : "ghost"}
          className="relative shrink-0"
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
              className="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-pill bg-primary text-secondary text-[10px] font-mono leading-[1.1rem] text-center"
              aria-hidden="true"
            >
              {filterActiveCount > 9 ? "9+" : filterActiveCount}
            </span>
          )}
        </Button>
      )}
      {selectButton}
      <div className="relative" ref={moreRef}>
        <Button
          type="button"
          size="iconSm"
          variant={moreOpen ? "accent" : "ghost"}
          className="shrink-0"
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => {
            haptic("light");
            setMoreOpen((v) => !v);
          }}
        >
          <MoreHorizontal size={16} />
        </Button>
        {moreOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 min-w-[12rem] rounded-large-element bg-secondary text-primary border-2 border-primary/20 p-2 shadow-lg animate-nav-slide-in"
          >
            {onColumnsChange && (
              <div className="px-2 py-1.5 space-y-1">
                <p className="text-xs font-mono">Grid density</p>
                <div className="flex gap-1">
                  {[3, 4, 5, 6].map((n) => (
                    <Button
                      key={n}
                      type="button"
                      size="sm"
                      variant={columns === n ? "accent" : "outline"}
                      className="min-w-[2rem]"
                      aria-label={`${n} columns`}
                      onClick={() => {
                        haptic("selection");
                        onColumnsChange(n);
                        setMoreOpen(false);
                      }}
                    >
                      {n}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {onOpenDates && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-pill px-3 py-2 text-sm text-left hover:bg-primary hover:text-secondary transition-colors"
                onClick={() => {
                  haptic("light");
                  setMoreOpen(false);
                  onOpenDates();
                }}
              >
                <CalendarDays size={16} aria-hidden="true" />
                Jump to date
              </button>
            )}
            {onRescan && (
              <button
                type="button"
                role="menuitem"
                disabled={rescanPending}
                className="flex w-full items-center gap-2 rounded-pill px-3 py-2 text-sm text-left hover:bg-primary hover:text-secondary transition-colors disabled:opacity-50"
                onClick={() => {
                  haptic("medium");
                  setMoreOpen(false);
                  onRescan();
                }}
              >
                Look again
              </button>
            )}
            {onOpenShortcuts && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-pill px-3 py-2 text-sm text-left hover:bg-primary hover:text-secondary transition-colors"
                onClick={() => {
                  haptic("light");
                  setMoreOpen(false);
                  onOpenShortcuts();
                }}
              >
                Keyboard shortcuts
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const clearQuery = () => {
    onQueryChange({ target: { value: "" } });
  };

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
          <div className="pr-1.5 py-1 shrink-0">
            <SegmentedControl
              options={segments}
              value={segment}
              onChange={onSegmentChange}
              surface="secondary"
            />
          </div>
        </div>
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
      <div className={cn(pillShell, "justify-center py-1 px-1.5")}>
        <SegmentedControl
          options={segments}
          value={segment}
          onChange={onSegmentChange}
          surface="secondary"
          className="w-full"
        />
      </div>
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
