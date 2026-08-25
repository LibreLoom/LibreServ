import { useState, useEffect, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import SettingsSidebar from "../components/settings/SettingsSidebar";
import SettingsContent from "../components/settings/SettingsContent";
import { visibleCategories } from "../components/settings/settingsCategories";
import { useAuth } from "../context/AuthContext";

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
  const isDesktop = useIsDesktop();
  const isAdmin = user?.role === "admin";
  const allowedCategoryIds = useMemo(
    () => visibleCategories(isAdmin).map((c) => c.id),
    [isAdmin],
  );

  const [selectedCategory, setSelectedCategory] = useState(() => {
    const hash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    if (hash) return hash;
    return "appearance";
  });
  const activeCategory = allowedCategoryIds.includes(selectedCategory)
    ? selectedCategory
    : "appearance";
  const [showMobileContent, setShowMobileContent] = useState(false);

  useEffect(() => {
    window.history.replaceState(null, "", `#${activeCategory}`);
  }, [activeCategory]);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (allowedCategoryIds.includes(hash)) {
        setSelectedCategory(hash);
        setShowMobileContent(true);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [allowedCategoryIds]);

  const handleCategoryChange = (category) => {
    setSelectedCategory(category);
    setShowMobileContent(true);
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
              onCategoryChange={setSelectedCategory}
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
                onCategoryChange={handleCategoryChange}
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
