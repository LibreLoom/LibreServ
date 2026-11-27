import { memo, useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
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
import usePageTitle from "../hooks/usePageTitle.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

const SearchResults = memo(SettingsSearchResults);

/** Hash without `#`. In-app Links use history.push, so we read the router location. */
function categoryFromHash(hash, allowedCategoryIds) {
  const raw = String(hash || "").replace(/^#/, "");
  // Cloud backup is part of Luna Connect now; old links still land there.
  const id = raw === "cloud_backup" ? "luna_connect" : raw;
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
  const [pendingHit, setPendingHit] = useState(
    /** @type {import("@libreloom/ui/lib/settingsSearch.js").SettingsHit | null} */ (null),
  );
  const [locationSelection, setLocationSelection] = useState({ key: location.key, category: hashCategory });
  if (locationSelection.key !== location.key || locationSelection.category !== hashCategory) {
    setLocationSelection({ key: location.key, category: hashCategory });
    setSelectedCategory(hashCategory || defaultCategory);
    setShowMobileContent(Boolean(hashCategory));
    if (pendingHit?.categoryId !== hashCategory) setPendingHit(null);
  }
  const activeLabel = categories.find((c) => c.id === activeCategory)?.label;
  usePageTitle(activeLabel ? `${activeLabel} settings` : "Settings");

  const selectCategory = useCallback((category) => {
    setPendingHit(null);
    setSelectedCategory(category);
    setShowMobileContent(true);
    if (location.hash.replace(/^#/, "") === category) return;
    navigate(
      { pathname: location.pathname, search: location.search, hash: category },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, navigate]);

  // Search: typing replaces the page with matches; picking one opens its
  // category and flashes the setting.
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const { results, resultQuery, firstResult, prepare } = useSettingsSearch(categories, query);
  const searchInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const categoryRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const scrollRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const focusSearchNextRef = useRef(false);
  const clearHighlight = useRef(() => {});
  useEffect(() => () => clearHighlight.current(), []);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = 0;
  }, [activeCategory, isDesktop, showMobileContent, searching]);

  // On a phone the box only exists on the category list, so `/` goes back to it first.
  useEffect(() => {
    if (!focusSearchNextRef.current || !searchInputRef.current) return;
    focusSearchNextRef.current = false;
    searchInputRef.current.focus({ preventScroll: true });
    searchInputRef.current.select();
  });
  useShortcut("/", () => {
    if (searchInputRef.current) {
      searchInputRef.current.focus({ preventScroll: true });
      searchInputRef.current.select();
    } else {
      focusSearchNextRef.current = true;
      setShowMobileContent(false);
    }
  }, { label: "Search settings", group: "Search", priority: 1 });

  const pickHit = useCallback((hit) => {
    setQuery("");
    selectCategory(hit.categoryId);
    setPendingHit(hit.kind === "category" ? null : hit);
  }, [selectCategory]);

  // A lazy category or a query-backed card can mount after the search closes.
  // Look only within the current category and only when its content changes.
  useEffect(() => {
    const root = categoryRef.current;
    if (!root || !pendingHit || searching || activeCategory !== pendingHit.categoryId) return undefined;
    let frame = 0;
    const timeout = window.setTimeout(() => setPendingHit(null), 3000);
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(schedule)
      : null;
    observer?.observe(root, { childList: true, subtree: true, characterData: true });
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(look);
    }
    const look = () => {
      frame = 0;
      const target = findSettingsTarget(root, pendingHit);
      if (target) {
        observer?.disconnect();
        clearHighlight.current();
        const reduce = typeof window.matchMedia === "function"
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
        target.classList.add("ring-2", "ring-accent");
        const removeRing = () => target.classList.remove("ring-2", "ring-accent");
        const highlightTimer = window.setTimeout(removeRing, 1800);
        clearHighlight.current = () => {
          window.clearTimeout(highlightTimer);
          removeRing();
        };
        setPendingHit(null);
      }
    };
    schedule();
    return () => {
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [pendingHit, searching, activeCategory, isDesktop, showMobileContent]);

  const searchField = (
    <SettingsSearchField
      value={query}
      onChange={setQuery}
      onSubmit={() => {
        const hit = firstResult();
        if (hit) pickHit(hit);
      }}
      inputRef={searchInputRef}
    />
  );
  // The first focus starts building the index so results are ready by the first key.
  const searchBox = <div onFocusCapture={prepare}>{searchField}</div>;
  const searchResults = searching
    ? <SearchResults query={resultQuery} results={resultQuery.trim() ? results : null} onPick={pickHit} />
    : null;

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
              memberHint="You're signed in as a Member. Some settings are only for an Admin."
              userHref="/settings#security"
              deviceName="this Luna"
              activeCategory={activeCategory}
              onCategoryChange={selectCategory}
            />
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 pl-10 pr-4 pb-24 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-1 duration-150">
            <div ref={categoryRef} hidden={searching}>
              <SettingsContent category={activeCategory} />
            </div>
            {searchResults}
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {!showMobileContent || searching ? (
            <div className="p-4 pt-6 pb-24">
              <h1 className="text-xl font-mono font-normal text-secondary mb-4 motion-safe:animate-in motion-safe:fade-in duration-150">Settings</h1>
              <div className="mb-3">{searchBox}</div>
              {searching ? (
                searchResults
              ) : (
              <SettingsSidebar
                user={user}
                categories={categories}
                memberHint="You're signed in as a Member. Some settings are only for an Admin."
                userHref="/settings#security"
                deviceName="this Luna"
                activeCategory={activeCategory}
                onCategoryChange={selectCategory}
              />
              )}
            </div>
          ) : (
            <div className="p-4 pt-6 pb-24 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 duration-150">
              <Button
                variant="ghost"
                surface="primary"
                size="sm"
                onClick={() => {
                  setPendingHit(null);
                  setShowMobileContent(false);
                }}
                className="mb-4 -ml-3"
              >
                <ArrowLeft size={ICON_SIZE.lg} />
                <span>Back</span>
              </Button>
              <div ref={categoryRef}><SettingsContent category={activeCategory} /></div>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
