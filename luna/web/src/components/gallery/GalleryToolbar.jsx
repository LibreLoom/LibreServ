import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import SegmentedControl from "../common/SegmentedControl";

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

export default function GalleryToolbar({
  segments,
  segment,
  onSegmentChange,
  query,
  onQueryChange,
}) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <div
        data-slot="gallery-toolbar"
        className={cn(pillShell, "mb-6 flex whitespace-nowrap")}
      >
        <GallerySearchInput
          id="photo-search"
          value={query}
          onChange={onQueryChange}
          placeholder="Search photos…"
        />
        <div className="pr-1.5 py-1 shrink-0">
          <SegmentedControl
            options={segments}
            value={segment}
            onChange={onSegmentChange}
          />
        </div>
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
      </div>
      <div className={cn(pillShell, "justify-center py-1 px-1.5")}>
        <SegmentedControl
          options={segments}
          value={segment}
          onChange={onSegmentChange}
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
};
