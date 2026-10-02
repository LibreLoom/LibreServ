import { Search, SearchX, X } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";
import { haptic } from "../../utils/haptics.js";
import Button from "../ui/Button.jsx";
import EmptyState from "../common/EmptyState.jsx";

/**
 * The "Search settings" box. Escape clears it (then leaves it); Enter picks the top hit.
 *
 * @param {{
 *   value: string,
 *   onChange: (value: string) => void,
 *   onSubmit?: () => void,
 *   inputRef?: any,
 *   className?: string,
 * }} props
 */
export function SettingsSearchField({ value, onChange, onSubmit, inputRef, className = "" }) {
  return (
    <div
      data-slot="settings-search"
      className={cn(
        "flex items-center gap-3 rounded-pill surface-secondary border-2 border-transparent px-4 py-2 focus-within:border-accent motion-safe:transition-colors",
        className,
      )}
    >
      <Search size={ICON_SIZE.md} className="shrink-0" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        aria-label="Search settings"
        aria-keyshortcuts="/"
        placeholder="Search settings"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit?.();
          } else if (event.key === "Escape") {
            if (value) {
              event.preventDefault();
              onChange("");
            } else {
              event.currentTarget.blur();
            }
          }
        }}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-primary shadow-none outline-none no-focus-outline"
      />
      {value ? (
        <Button variant="ghost" surface="secondary" size="iconSm" aria-label="Clear the settings search" onClick={() => onChange("")}>
          <X size={ICON_SIZE.sm} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/** "Appearance › Theme" style trail for a hit. @param {import("../../lib/settingsSearch.js").SettingsHit} hit */
function trail(hit) {
  if (hit.kind === "category") return "Settings section";
  return [hit.categoryLabel, hit.kind === "row" ? hit.cardTitle : ""].filter(Boolean).join(" › ");
}

/** @param {string} text */
function preview(text) {
  return text.length > 110 ? `${text.slice(0, 110).trimEnd()}…` : text;
}

/**
 * What the search found. `results` is null while the index is still being built.
 *
 * @param {{
 *   query: string,
 *   results: import("../../lib/settingsSearch.js").SettingsHit[] | null,
 *   onPick: (hit: import("../../lib/settingsSearch.js").SettingsHit) => void,
 * }} props
 */
export function SettingsSearchResults({ query, results, onPick }) {
  return (
    <div data-slot="settings-search-results" className="space-y-4">
      <h1 className="sticky top-0 z-10 surface-primary pt-1 text-2xl font-mono font-normal text-secondary">Search results</h1>
      <p role="status" className="sr-only">
        {results ? `${results.length} ${results.length === 1 ? "match" : "matches"}` : "Searching settings"}
      </p>
      {results && results.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={`Nothing in Settings matches "${query.trim()}".`}
          description="Try a shorter or different word."
        />
      ) : null}
      {results && results.length > 0 ? (
        <ul className="grid gap-2 pb-16 md:pb-20">
          {results.map((hit) => (
            <li key={`${hit.categoryId}/${hit.kind}/${hit.cardTitle}/${hit.title}`}>
              <button
                type="button"
                onClick={() => {
                  haptic("selection");
                  onPick(hit);
                }}
                className="block w-full rounded-large-element surface-secondary px-4 py-3 text-left hover:ring-2 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-shadow"
              >
                <span className="block font-mono">{hit.title}</span>
                <span className="block text-sm">{trail(hit)}</span>
                {hit.text ? <span className="mt-1 block text-sm">{preview(hit.text)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
