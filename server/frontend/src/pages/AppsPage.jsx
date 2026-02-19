import { useEffect, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import HeaderCard from "../components/common/cards/HeaderCard";
import Card from "../components/common/cards/Card";
import Dropdown from "../components/common/Dropdown";
import AppIcon from "../components/common/AppIcon";
import {
  Search,
  Download,
  Check,
  Settings,
} from "lucide-react";

function AppCatalogCard({ app, isInstalled, onInstall }) {
  return (
    <Card className="relative flex flex-col h-full">
      <div className="flex items-start gap-4">
        <AppIcon appId={app.id} size={48} className="flex-shrink-0" />

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
        </div>
      </div>

      <p className="text-sm text-primary/70 mt-3 line-clamp-2">
        {app.description}
      </p>

      {app.category && (
        <span className="mt-2 self-start px-2 py-1 rounded-large-element bg-secondary/10 text-xs font-mono text-primary/50 capitalize">
          {app.category}
        </span>
      )}

      <div className="flex-1" />

      {!isInstalled && (
        <button
          onClick={() => onInstall(app.id)}
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:outline-accent hover:ring-2 transition-all font-mono font-medium text-sm"
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
    if (installedAppIds.has(app.id)) return false;

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
        <div className="relative w-full sm:max-w-sm transition-all duration-300">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-secondary/50"
          />
          <input
            type="text"
            placeholder="Search apps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-11 pr-4 py-2 border-2 border-secondary/30 rounded-pill bg-primary text-secondary focus:outline-2 focus:outline-accent focus:outline-offset-2 transition-all duration-300"
          />
        </div>

        {categories.length > 1 && (
          <Dropdown
            label="Category"
            value={selectedCategory}
            onChange={setSelectedCategory}
            placeholder="All Categories"
            width={160}
            options={[
              { value: null, label: "All Categories" },
              ...categories.map((cat) => ({
                value: cat,
                label: cat.charAt(0).toUpperCase() + cat.slice(1),
              })),
            ]}
          />
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

      {installedApps.length > 0 && (
        <section className="mt-10" aria-label="Installed apps">
          <h2 className="text-xl font-mono font-normal mb-4 text-primary/70">
            Installed Apps
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {installedApps.map((app) => (
              <Card key={app.id} className="relative flex flex-col">
                <div className="flex items-start gap-4">
                  <AppIcon appId={app.app_id} size={48} className="flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-mono text-lg text-primary truncate">
                      {app.name}
                    </h3>
                    <p className={`text-sm capitalize ${
                      app.status === "running" ? "text-success" :
                      app.status === "stopped" ? "text-warning" : "text-primary/50"
                    }`}>
                      {app.status}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <Link
                    to={`/apps/${app.id}`}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-secondary/10 text-primary hover:bg-secondary/20 transition-colors font-mono text-sm"
                  >
                    <Settings size={16} />
                    Manage
                  </Link>
                  {app.url && (
                    <a
                      href={app.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/80 transition-colors font-mono text-sm"
                    >
                      Open
                    </a>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
