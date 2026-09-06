import { useState, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import SettingsSidebar from "../components/settings/SettingsSidebar";
import SettingsContent from "../components/settings/SettingsContent";
import { visibleCategories } from "../components/settings/settingsCategories";
import { useAuth } from "../context/AuthContext";
import useConnectActive from "../hooks/useConnectActive";

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
  const allowedCategoryIds = useMemo(
    () => visibleCategories(isAdmin, connectActive).map((c) => c.id),
    [isAdmin, connectActive],
  );
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

  return (
    <Page
      padded={false}
      className="h-[100dvh] flex flex-col overflow-hidden pt-0 pb-0"
    >
      {isDesktop ? (
        <div className="flex flex-1 gap-6 px-8 pt-5 overflow-hidden min-h-0">
          <div className="w-[28%] min-w-[260px] max-w-[360px] flex-shrink-0 overflow-y-auto pb-24">
            <SettingsSidebar
              user={user}
              activeCategory={activeCategory}
              onCategoryChange={selectCategory}
            />
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 pl-10 pr-4 pb-24 animate-in fade-in slide-in-from-right-1 duration-150">
            <SettingsContent category={activeCategory} />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          {!showMobileContent ? (
            <div className="p-4 pt-6 pb-24">
              <h1 className="text-xl font-mono font-normal text-secondary mb-4 animate-in fade-in duration-150">
                Settings
              </h1>
              <SettingsSidebar
                user={user}
                activeCategory={activeCategory}
                onCategoryChange={selectCategory}
              />
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
                <ArrowLeft size={18} />
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
