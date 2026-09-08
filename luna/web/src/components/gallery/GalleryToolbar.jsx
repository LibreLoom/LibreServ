import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { CalendarDays, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import SegmentedControl from "../common/SegmentedControl";
import Button from "../ui/Button.jsx";

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
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

const pillShell =
  "flex items-center gap-1 bg-secondary text-primary rounded-pill p-1 border-2 border-primary/20 focus-within:border-accent transition-colors";

const searchFieldShell = "relative flex-1 min-w-0 bg-primary text-secondary rounded-pill";

const searchInputClass =
  "w-full pl-11 pr-3 py-2.5 bg-transparent text-secondary placeholder:text-accent focus:outline-none no-focus-outline font-mono text-sm";

/**
 * @param {{ id: string, value: string, onChange: (e: any) => void, placeholder: string, className?: string }} props
 */
function GallerySearchInput({ id, value, onChange, placeholder, className }) {
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
        aria-label="Search photos"
        className={searchInputClass}
      />
    </div>
  );
}

GallerySearchInput.propTypes = {
  id: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  placeholder: PropTypes.string.isRequired,
  className: PropTypes.string,
};

/**
 * @param {{
 *   segments: Array<{value:string,label:string}>,
 *   segment: string,
 *   onSegmentChange: (v: string) => void,
 *   query: string,
 *   onQueryChange: (e: any) => void,
 *   selectMode?: boolean,
 *   onSelectModeChange?: (on: boolean) => void,
 *   onOpenDates?: () => void,
 *   dateFrom?: string,
 *   dateTo?: string,
 *   onDateFromChange?: (v: string) => void,
 *   onDateToChange?: (v: string) => void,
 *   columns?: number,
 *   onColumnsChange?: (n: number) => void,
 *   showSelect?: boolean,
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
  dateFrom = "",
  dateTo = "",
  onDateFromChange,
  onDateToChange,
  columns = 6,
  onColumnsChange,
  showSelect = true,
}) {
  const isDesktop = useIsDesktop();

  const selectButton = showSelect && onSelectModeChange ? (
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

  const density = onColumnsChange ? (
    <label className="flex items-center gap-1 shrink-0 text-xs font-mono px-1">
      <span className="sr-only">Grid density</span>
      <select
        aria-label="Grid density"
        value={columns}
        onChange={(e) => onColumnsChange(Number(e.target.value))}
        className="rounded-pill bg-primary text-secondary border-0 px-2 py-1 focus:outline-none no-focus-outline"
      >
        <option value={3}>3</option>
        <option value={4}>4</option>
        <option value={5}>5</option>
        <option value={6}>6</option>
      </select>
    </label>
  ) : null;

  const dateJump = onOpenDates ? (
    <Button
      type="button"
      size="iconSm"
      variant="ghost"
      className="shrink-0"
      aria-label="Jump to a date"
      onClick={onOpenDates}
    >
      <CalendarDays size={16} />
    </Button>
  ) : null;

  const dateRange =
    onDateFromChange && onDateToChange ? (
      <div className="flex items-center gap-1 shrink-0 px-1">
        <input
          type="date"
          aria-label="From date"
          value={dateFrom}
          onChange={(e) => onDateFromChange(e.target.value)}
          className="rounded-pill bg-primary text-secondary border-0 px-2 py-1 text-xs font-mono focus:outline-none no-focus-outline max-w-[9.5rem]"
        />
        <span className="text-xs" aria-hidden="true">
          –
        </span>
        <input
          type="date"
          aria-label="To date"
          value={dateTo}
          onChange={(e) => onDateToChange(e.target.value)}
          className="rounded-pill bg-primary text-secondary border-0 px-2 py-1 text-xs font-mono focus:outline-none no-focus-outline max-w-[9.5rem]"
        />
      </div>
    ) : null;

  if (isDesktop) {
    return (
      <div className="mb-6 space-y-3" data-slot="gallery-toolbar">
        <div className={cn(pillShell, "flex whitespace-nowrap")}>
          <GallerySearchInput
            id="photo-search"
            value={query}
            onChange={onQueryChange}
            placeholder="Search photos…"
          />
          {dateJump}
          {density}
          {selectButton}
          <div className="pr-1.5 py-1 shrink-0">
            <SegmentedControl
              options={segments}
              value={segment}
              onChange={onSegmentChange}
              surface="secondary"
            />
          </div>
        </div>
        {dateRange}
      </div>
    );
  }

  return (
    <div data-slot="gallery-toolbar" className="mb-6 space-y-3">
      <div className={pillShell}>
        <GallerySearchInput
          id="photo-search-mobile"
          value={query}
          onChange={onQueryChange}
          placeholder="Search photos…"
        />
        {dateJump}
        {density}
        {selectButton}
      </div>
      {dateRange}
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
  selectMode: PropTypes.bool,
  onSelectModeChange: PropTypes.func,
  onOpenDates: PropTypes.func,
  dateFrom: PropTypes.string,
  dateTo: PropTypes.string,
  onDateFromChange: PropTypes.func,
  onDateToChange: PropTypes.func,
  columns: PropTypes.number,
  onColumnsChange: PropTypes.func,
  showSelect: PropTypes.bool,
};
