import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SettingsSidebar from "@libreloom/ui/components/settings/SettingsSidebar.jsx";
import { SettingsSearchField, SettingsSearchResults } from "@libreloom/ui/components/settings/SettingsSearch.jsx";
import { useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";
import { findSettingsTarget } from "@libreloom/ui/lib/settingsSearch.js";
import SettingsContent from "../components/settings/SettingsContent";
import useSettingsSearch from "../components/settings/useSettingsSearch.jsx";
import { visibleCategories } from "../components/settings/settingsCategories";
import { useAuth } from "../context/AuthContext";
import useConnectActive from "../hooks/useConnectActive";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

/** Old category ids → current sidebar ids (bookmarks / deep links). */
const HASH_ALIASES = {
  remote: "external_services",
  access: "security",
};

/** Hash without `#`. In-app Links use history.push, so we read the router location. */
function categoryFromHash(hash, allowedCategoryIds) {
  const raw = String(hash || "").replace(/^#/, "");
  const id = HASH_ALIASES[raw] || raw;
  return allowedCategoryIds.includes(id) ? id : null;
}

function useIsDesktop() {
  // jsdom has no layout CSS, so we pick one chrome with matchMedia. If
  // matchMedia is missing (tests), treat the window as desktop.
  const read = () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
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

export default function SettingsPage() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const isAdmin = user?.role === "admin";
  const connectActive = useConnectActive();
  const categories = useMemo(
    () => visibleCategories(isAdmin, connectActive),
    [isAdmin, connectActive],
  );
  const allowedCategoryIds = useMemo(() => categories.map((c) => c.id), [categories]);
  const defaultCategory = "appearance";
  const hashCategory = categoryFromHash(location.hash, allowedCategoryIds);

  const [selectedCategory, setSelectedCategory] = useState(
    () => categoryFromHash(location.hash, allowedCategoryIds) || defaultCategory,
  );
  const activeCategory = allowedCategoryIds.includes(selectedCategory)
    ? selectedCategory
    : defaultCategory;
  const [showMobileContent, setShowMobileContent] = useState(() => Boolean(hashCategory));

  // React Router Link updates location.hash via pushState — no hashchange event —
  // and Settings stays mounted (same pathname). Follow the router hash.
  useEffect(() => {
    if (!hashCategory) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync selection to router hash
    setSelectedCategory(hashCategory);
    setShowMobileContent(true);
  }, [hashCategory]);

  const selectCategory = (category) => {
    setSelectedCategory(category);
    setShowMobileContent(true);
    if (location.hash.replace(/^#/, "") === category) return;
    navigate(
      { pathname: location.pathname, search: location.search, hash: category },
      { replace: true },
    );
  };

  // Search: typing replaces the page with matches; picking one opens its
  // category and flashes the setting.
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const { results, prepare } = useSettingsSearch(categories, query);
  const searchInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const focusSearchNextRef = useRef(false);
  const [pendingHit, setPendingHit] = useState(
    /** @type {import("@libreloom/ui/lib/settingsSearch.js").SettingsHit | null} */ (null),
  );

  // On a phone the box only exists on the category list, so `/` goes back to it first.
  useEffect(() => {
    if (!focusSearchNextRef.current || !searchInputRef.current) return;
    focusSearchNextRef.current = false;
    searchInputRef.current.focus();
    searchInputRef.current.select();
  });
  useShortcut("/", () => {
    if (searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    } else {
      focusSearchNextRef.current = true;
      setShowMobileContent(false);
    }
  }, { label: "Search settings", group: "Search", priority: 1 });

  const pickHit = (hit) => {
    setQuery("");
    selectCategory(hit.categoryId);
    setPendingHit(hit.kind === "category" ? null : hit);
  };

  // The category draws in (and its cards fade in) after the pick, so look for
  // the setting for a moment, then scroll to it and ring it briefly.
  useEffect(() => {
    if (!pendingHit || searching) return undefined;
    let tries = 0;
    const timers = /** @type {number[]} */ ([]);
    const look = () => {
      const target = findSettingsTarget(document, pendingHit);
      if (target) {
        const reduce = typeof window.matchMedia === "function"
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
        target.classList.add("ring-2", "ring-accent");
        timers.push(window.setTimeout(() => target.classList.remove("ring-2", "ring-accent"), 1800));
        setPendingHit(null);
      } else if (++tries < 30) {
        timers.push(window.setTimeout(look, 100));
      } else {
        setPendingHit(null);
      }
    };
    timers.push(window.setTimeout(look, 0));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [pendingHit, searching, activeCategory]);

  const searchField = (
    <SettingsSearchField
      value={query}
      onChange={setQuery}
      onSubmit={() => results?.[0] && pickHit(results[0])}
      inputRef={searchInputRef}
    />
  );
  // The first focus starts building the index so results are ready by the first key.
  const searchBox = <div onFocusCapture={prepare}>{searchField}</div>;
  const body = searching
    ? <SettingsSearchResults query={query} results={results} onPick={pickHit} />
    : <SettingsContent category={activeCategory} />;

  return (
    <Page
      padded={false}
      className="h-[100dvh] flex flex-col overflow-hidden pt-0 pb-0"
    >
      {isDesktop ? (
        <div className="flex flex-1 gap-6 px-8 pt-5 overflow-hidden min-h-0">
          <div className="w-[28%] min-w-[260px] max-w-[360px] flex-shrink-0 overflow-y-auto pb-24">
            <div className="mb-3">{searchBox}</div>
            <SettingsSidebar
              user={user}
              categories={categories}
              memberHint="You're signed in as a Member. Ask an Admin to change External Services or About."
              userHref={(u) => (u.role === "admin" ? "/settings/users" : null)}
              deviceName="this Luna"
              activeCategory={activeCategory}
              onCategoryChange={selectCategory}
            />
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 pl-10 pr-4 pb-24 animate-in fade-in slide-in-from-right-1 duration-150">
            {body}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          {!showMobileContent || searching ? (
            <div className="p-4 pt-6 pb-24">
              <h1 className="text-xl font-mono font-normal text-secondary mb-4 animate-in fade-in duration-150">
                Settings
              </h1>
              <div className="mb-3">{searchBox}</div>
              {searching ? (
                <SettingsSearchResults query={query} results={results} onPick={pickHit} />
              ) : (
              <SettingsSidebar
                user={user}
                categories={categories}
                memberHint="You're signed in as a Member. Ask an Admin to change External Services or About."
                userHref={(u) => (u.role === "admin" ? "/settings/users" : null)}
                deviceName="this Luna"
                activeCategory={activeCategory}
                onCategoryChange={selectCategory}
              />
              )}
            </div>
          ) : (
            <div className="p-4 pt-6 pb-24 animate-in fade-in slide-in-from-right-2 duration-150">
              <Button
                variant="ghost"
                surface="primary"
                size="sm"
                onClick={() => setShowMobileContent(false)}
                className="mb-4 -ml-3"
              >
                <ArrowLeft size={ICON_SIZE.lg} />
                <span>Back</span>
              </Button>
              <SettingsContent category={activeCategory} />
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
