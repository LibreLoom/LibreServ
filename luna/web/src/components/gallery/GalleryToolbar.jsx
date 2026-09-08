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

const pillShell =
  "flex items-center gap-1 bg-secondary text-primary rounded-pill p-1 border-2 border-primary/20 focus-within:border-accent transition-colors";

const searchInputClass =
  "w-full pl-11 pr-10 py-2.5 bg-transparent text-secondary placeholder:text-accent focus:outline-none no-focus-outline font-mono text-sm";

/**
 * Calm Photos chrome: segments + a few icon buttons. Search and filters stay tucked away.
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
 * }} props
 */
export default function GalleryToolbar({
  segments,
  segment,
  onSegmentChange,
  query,
  onQueryChange,
  searchOpen: searchOpenProp,
  onSearchOpenChange,
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
}) {
  const [internalSearchOpen, setInternalSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const searchInputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const moreRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  const controlled = typeof onSearchOpenChange === "function";
  const searchOpen = controlled ? !!searchOpenProp : internalSearchOpen;

  function setSearchOpen(open) {
    if (controlled) onSearchOpenChange?.(open);
    else setInternalSearchOpen(open);
  }

  useEffect(() => {
    if (!searchOpen) return undefined;
    const id = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [searchOpen]);

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

  function clearAndCloseSearch() {
    if (query) {
      onQueryChange({ target: { value: "" } });
    }
    setSearchOpen(false);
  }

  function onSearchKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      clearAndCloseSearch();
    }
  }

  const selectButton =
    showSelect && onSelectModeChange ? (
      <Button
        type="button"
        size="sm"
        variant={selectMode ? "accent" : "ghost"}
        className="shrink-0"
        onClick={() => onSelectModeChange(!selectMode)}
      >
        {selectMode ? "Cancel" : "Select"}
      </Button>
    ) : null;

  const iconButtons = (
    <div className="flex items-center gap-0.5 shrink-0 pr-0.5">
      <Button
        type="button"
        size="iconSm"
        variant={searchOpen || query ? "accent" : "ghost"}
        className="shrink-0"
        aria-label="Search photos"
        aria-pressed={searchOpen}
        onClick={() => setSearchOpen(!searchOpen)}
      >
        <Search size={16} />
      </Button>
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
          onClick={onOpenFilters}
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
          onClick={() => setMoreOpen((v) => !v)}
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

  return (
    <div className="mb-6 space-y-3" data-slot="gallery-toolbar">
      <div className={cn(pillShell, "flex flex-wrap justify-between gap-1")}>
        <div className="min-w-0 flex-1 overflow-x-auto py-1 pl-1.5 pr-1">
          <SegmentedControl
            options={segments}
            value={segment}
            onChange={onSegmentChange}
            surface="secondary"
            className="w-max min-w-full sm:w-auto"
          />
        </div>
        {iconButtons}
      </div>

      {searchOpen && (
        <div
          className={cn(pillShell, "animate-nav-slide-in")}
          data-slot="gallery-search-row"
        >
          <div className="relative flex-1 min-w-0 bg-primary text-secondary rounded-pill">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-accent pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              id="photo-search"
              type="search"
              placeholder="Search photos…"
              value={query}
              onChange={onQueryChange}
              onKeyDown={onSearchKeyDown}
              aria-label="Search photos"
              className={searchInputClass}
            />
            <Button
              type="button"
              size="iconSm"
              variant="ghost"
              surface="primary"
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              aria-label="Close search"
              onClick={clearAndCloseSearch}
            >
              <X size={16} />
            </Button>
          </div>
        </div>
      )}

      {!searchOpen && !!query && (
        <div className="flex flex-wrap gap-2" data-slot="gallery-search-chip">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-pill bg-secondary text-primary border-2 border-primary/20 px-3 py-1.5 text-sm font-mono hover:border-accent transition-colors"
            onClick={() => setSearchOpen(true)}
            aria-label={`Search: ${query}. Click to edit.`}
          >
            <Search size={14} aria-hidden="true" />
            <span className="max-w-[14rem] truncate">{query}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear search"
              className="rounded-pill p-0.5 hover:bg-primary hover:text-secondary"
              onClick={(e) => {
                e.stopPropagation();
                onQueryChange({ target: { value: "" } });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onQueryChange({ target: { value: "" } });
                }
              }}
            >
              <X size={14} />
            </span>
          </button>
        </div>
      )}
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
};
