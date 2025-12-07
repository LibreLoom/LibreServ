import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, RefreshCw } from 'lucide-react';
import { Sidebar } from '../components/layout';
import { Input, Button } from '../components/ui';
import AppCard from '../components/AppCard';
import { appsApi, monitoringApi } from '../api';

const Dashboard = () => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [apps, setApps] = useState([]);
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Load apps and system health in parallel
      const [appsResponse, healthResponse] = await Promise.all([
        appsApi.listInstalled().catch(() => ({ apps: [] })),
        monitoringApi.getSystemHealth().catch(() => null),
      ]);

      // Transform apps data
      const transformedApps = (appsResponse.apps || []).map(app => ({
        id: app.id,
        name: app.name,
        status: app.status || 'stopped',
        resourceUsage: app.resource_usage || 0,
        url: app.url || null,
        breakdown: app.breakdown || null,
      }));

      setApps(transformedApps);

      // Set stats (mock data if API doesn't return it yet)
      setStats({
        uptime: { days: 41, hours: 15 },
        storage: { used: 128, total: 512 },
        resources: {
          overall: 41,
          breakdown: [
            { label: 'CPU', value: '23%' },
            { label: 'RAM', value: '48%' },
            { label: 'Disk I/O', value: '12%' },
            { label: 'Network', value: '5%' },
          ],
        },
      });
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      setError('Failed to load data. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await loadData();
    setIsRefreshing(false);
  };

  const handleManageApp = (app) => {
    navigate(`/apps/${app.id}`);
  };

  const filteredApps = apps.filter(app => 
    app.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Mock apps for development if no apps are loaded
  const displayApps = apps.length > 0 ? filteredApps : [
    {
      id: 'nextcloud',
      name: 'Nextcloud',
      status: 'running',
      resourceUsage: 35,
      url: 'https://cloud.example.com',
      breakdown: [
        { label: 'CPU', value: '15%' },
        { label: 'RAM', value: '45%' },
        { label: 'Disk', value: '28%' },
      ],
    },
    {
      id: 'convertx',
      name: 'ConvertX',
      status: 'running',
      resourceUsage: 12,
      url: null,
      breakdown: [
        { label: 'CPU', value: '8%' },
        { label: 'RAM', value: '12%' },
        { label: 'Disk', value: '5%' },
      ],
    },
    {
      id: 'searxng',
      name: 'SearXNG',
      status: 'running',
      resourceUsage: 8,
      url: 'https://search.example.com',
      breakdown: [
        { label: 'CPU', value: '5%' },
        { label: 'RAM', value: '10%' },
        { label: 'Disk', value: '2%' },
      ],
    },
  ].filter(app => app.name.toLowerCase().includes(searchQuery.toLowerCase()));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-mono text-[var(--color-accent)]">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Sidebar with Stats */}
      <Sidebar stats={stats} />

      {/* Main Content */}
      <div className="flex-1">
        {/* Search Bar and Refresh */}
        <div className="flex gap-3 mb-6">
          <div className="relative flex-1">
            <Search 
              className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-accent)]" 
              size={18} 
            />
            <Input
              type="search"
              placeholder="Search apps..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-12"
            />
          </div>
          <Button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="px-3"
            title="Refresh"
          >
            <RefreshCw size={18} className={isRefreshing ? 'animate-spin' : ''} />
          </Button>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border-2 border-red-500 rounded-xl text-red-500 text-center">
            {error}
            <Button 
              variant="outline" 
              size="sm" 
              className="ml-4"
              onClick={handleRefresh}
            >
              Retry
            </Button>
          </div>
        )}

        {/* App Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {displayApps.map(app => (
            <AppCard 
              key={app.id} 
              app={app} 
              onManage={handleManageApp}
            />
          ))}
        </div>

        {displayApps.length === 0 && (
          <div className="text-center py-12">
            <p className="font-mono text-[var(--color-accent)]">
              {searchQuery 
                ? `No apps found matching "${searchQuery}"`
                : 'No apps installed yet. Visit the catalog to get started!'
              }
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
