import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import HeaderCard from "../components/common/cards/HeaderCard";
import Card from "../components/common/cards/Card";
import {
  Search,
  Cloud,
  Cpu,
  Shield,
  FileText,
  Zap,
  Download,
  Check,
} from "lucide-react";

const categoryIcons = {
  productivity: Cloud,
  media: FileText,
  development: Cpu,
  ai: Zap,
  search: Search,
  storage: Cloud,
  security: Shield,
  other: FileText,
};

function AppCatalogCard({ app, isInstalled, onInstall }) {
  const Icon = categoryIcons[app.category] || FileText;

  return (
    <Card className="relative">
      <div className="flex items-start gap-4">
        {app.icon ? (
          <img
            src={app.icon}
            alt=""
            className="w-12 h-12 rounded-large-element object-contain bg-secondary/10 p-1"
            onError={(e) => {
              e.target.style.display = "none";
            }}
          />
        ) : (
          <div className="w-12 h-12 rounded-large-element bg-secondary/10 flex items-center justify-center">
            <Icon size={24} className="text-secondary/50" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-lg text-primary truncate">
              {app.name}
            </h3>
            {isInstalled && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-accent/20 text-accent text-xs font-mono">
                <Check size={12} />
                Installed
              </span>
            )}
          </div>

          <p className="text-sm text-primary/70 mt-1 line-clamp-2">
            {app.description}
          </p>

          <div className="flex items-center gap-2 mt-3">
            {app.category && (
              <span className="px-2 py-1 rounded-large-element bg-secondary/10 text-xs font-mono text-primary/50 capitalize">
                {app.category}
              </span>
            )}
          </div>
        </div>
      </div>

      {!isInstalled && (
        <button
          onClick={() => onInstall(app.id)}
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/90 motion-safe:transition-all font-mono text-sm"
        >
          <Download size={16} />
          Install
        </button>
      )}

      {isInstalled && (
        <button
          disabled
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-secondary/10 text-secondary/50 font-mono text-sm cursor-not-allowed"
        >
          <Check size={16} />
          Already Installed
        </button>
      )}
    </Card>
  );
}

export default function AppsPage() {
  const navigate = useNavigate();
  const { request } = useAuth();

  const [catalog, setCatalog] = useState([]);
  const [installedApps, setInstalledApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(null);

  useEffect(() => {
    let delayTimer;
    const fetchData = async () => {
      try {
        delayTimer = setTimeout(() => {
          setShowLoading(true);
        }, 500);
        const [catalogRes, installedRes] = await Promise.all([
          request("/catalog"),
          request("/apps"),
        ]);

        const catalogData = await catalogRes.json();
        const installedData = await installedRes.json();

        setCatalog(catalogData.apps || []);
        setInstalledApps(installedData.apps || []);
      } catch (err) {
        console.error("Failed to load data:", err);
        setError("Failed to load app catalog. Please try again.");
      } finally {
        clearTimeout(delayTimer);
        setShowLoading(false);
        setLoading(false);
      }
    };
    fetchData();
    return () => clearTimeout(delayTimer);
  }, [request]);

  const handleInstall = useCallback(
    (appId) => {
      navigate(`/apps/install/${appId}`);
    },
    [navigate],
  );

  const installedAppIds = new Set(installedApps.map((app) => app.app_id));

  const categories = [
    ...new Set(catalog.map((app) => app.category).filter(Boolean)),
  ];

  const filteredCatalog = catalog.filter((app) => {
    const matchesSearch =
      !searchQuery ||
      app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.description?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCategory =
      !selectedCategory || app.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  if (error) {
    return (
      <main className="bg-primary text-secondary px-8 pt-5 pb-32">
        <HeaderCard id="apps-title" title="Apps" />
        <div className="mt-8 text-center">
          <p className="text-secondary/70">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-6 py-2 rounded-pill bg-accent text-primary"
          >
            Try Again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`bg-primary text-secondary px-8 pt-5 pb-32 ${showLoading ? "pop-out" : "pop-in"}`}
      aria-labelledby="apps-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard id="apps-title" title="Apps" />

      {loading && showLoading && (
        <div className="fixed inset-0 flex items-center justify-center">
          <Card className="w-[70vw] sm:w-[20vw]">
            <div
              className="my-5 text-center"
              role="status"
              aria-live="polite"
            >
              <p>Loading apps...</p>
            </div>
          </Card>
        </div>
      )}

      <div className="mt-5 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-secondary/50"
          />
          <input
            type="text"
            placeholder="Search apps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-11 pr-4 py-2 border-2 border-secondary/30 rounded-pill bg-primary text-secondary focus:outline-2 focus:outline-accent focus:outline-offset-2"
          />
        </div>

        {categories.length > 1 && (
          <select
            value={selectedCategory || ""}
            onChange={(e) => setSelectedCategory(e.target.value || null)}
            className="px-4 py-2 border-2 border-secondary/30 rounded-pill bg-primary text-secondary focus:outline-2 focus:outline-accent focus:outline-offset-2 cursor-pointer"
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat} className="capitalize">
                {cat}
              </option>
            ))}
          </select>
        )}
      </div>

      {filteredCatalog.length === 0 && !loading && (
        <div className="mt-12 text-center">
          <p className="text-secondary/70">
            {searchQuery || selectedCategory
              ? "No apps match your search."
              : "No apps available."}
          </p>
        </div>
      )}

      {filteredCatalog.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredCatalog.map((app) => (
            <AppCatalogCard
              key={app.id}
              app={app}
              isInstalled={installedAppIds.has(app.id)}
              onInstall={handleInstall}
            />
          ))}
        </div>
      )}
    </main>
  );
}
