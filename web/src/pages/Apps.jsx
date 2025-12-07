import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Search, 
  Plus, 
  Grid,
  List,
  Play,
  Square,
  RotateCcw,
  ExternalLink,
  Download,
  AlertCircle
} from 'lucide-react';
import { Card, Button, Input, StatusIndicator, Pill, Modal } from '../components/ui';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useApps, useAppActions, useCatalog, useInstallApp } from '../hooks';

// Mock data for development/fallback
const MOCK_APPS = [
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Self-hosted productivity platform',
    status: 'running',
    version: '27.1.5',
    updateAvailable: true,
    newVersion: '28.0.0',
    url: 'https://cloud.local',
    resourceUsage: { cpu: 15, memory: 45, disk: 28 },
    installedAt: '2024-01-15',
  },
  {
    id: 'convertx',
    name: 'ConvertX',
    description: 'File conversion service',
    status: 'running',
    version: '1.2.0',
    updateAvailable: false,
    url: null,
    resourceUsage: { cpu: 8, memory: 12, disk: 5 },
    installedAt: '2024-02-20',
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    description: 'Privacy-respecting metasearch engine',
    status: 'running',
    version: '2024.1.1',
    updateAvailable: false,
    url: 'https://search.local',
    resourceUsage: { cpu: 5, memory: 10, disk: 2 },
    installedAt: '2024-03-01',
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    description: 'Password manager server',
    status: 'stopped',
    version: '1.30.0',
    updateAvailable: true,
    newVersion: '1.31.0',
    url: 'https://vault.local',
    resourceUsage: { cpu: 0, memory: 0, disk: 1 },
    installedAt: '2024-01-10',
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    description: 'Media streaming server',
    status: 'running',
    version: '10.8.13',
    updateAvailable: false,
    url: 'https://media.local',
    resourceUsage: { cpu: 25, memory: 35, disk: 150 },
    installedAt: '2024-02-01',
  },
];

const MOCK_CATALOG = [
  { id: 'gitea', name: 'Gitea', description: 'Git service', category: 'Development' },
  { id: 'immich', name: 'Immich', description: 'Photo management', category: 'Media' },
  { id: 'homeassistant', name: 'Home Assistant', description: 'Home automation', category: 'IoT' },
  { id: 'pihole', name: 'Pi-hole', description: 'Network ad blocker', category: 'Network' },
  { id: 'syncthing', name: 'Syncthing', description: 'File synchronization', category: 'Storage' },
];

export default function Apps() {
  const navigate = useNavigate();
  const { haptic } = useTheme();
  const { hasPermission } = useAuth();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [useMockData, setUseMockData] = useState(false);
  const [localApps, setLocalApps] = useState(MOCK_APPS);
  const [actionLoading, setActionLoading] = useState(null);

  // Fetch real data from API
  const { apps: apiApps, isLoading, error: appsError, refetch } = useApps({ poll: true, pollInterval: 10000 });
  const { apps: catalogApps, isLoading: catalogLoading, error: catalogError } = useCatalog({ immediate: true });
  const { install, isLoading: installLoading } = useInstallApp();

  // Detect API availability
  useEffect(() => {
    if (appsError) {
      setUseMockData(true);
    }
  }, [appsError]);

  // Transform API apps to display format
  const apps = useMemo(() => {
    if (useMockData || appsError) return localApps;
    
    return apiApps.map(app => ({
      id: app.instance_id || app.id,
      name: app.name || app.app_id,
      description: app.description || '',
      status: app.status || 'unknown',
      version: app.version || 'N/A',
      updateAvailable: app.update_available || false,
      newVersion: app.new_version || null,
      url: app.url || null,
      resourceUsage: {
        cpu: app.resource_usage?.cpu || 0,
        memory: app.resource_usage?.memory || 0,
        disk: app.resource_usage?.disk || 0,
      },
      installedAt: app.installed_at || new Date().toISOString().split('T')[0],
    }));
  }, [apiApps, appsError, useMockData, localApps]);

  // Available apps for installation
  const availableApps = useMemo(() => {
    if (useMockData || catalogError) {
      // Filter out already installed apps
      const installedIds = new Set(localApps.map(a => a.id));
      return MOCK_CATALOG.filter(a => !installedIds.has(a.id));
    }
    
    // Filter catalog to exclude installed apps
    const installedIds = new Set(apps.map(a => a.id));
    return (catalogApps || []).filter(a => !installedIds.has(a.id));
  }, [catalogApps, catalogError, apps, useMockData, localApps]);

  const handleAppAction = async (appId, action) => {
    if (!hasPermission('manage', appId)) {
      alert('You do not have permission to perform this action');
      return;
    }

    setActionLoading(`${appId}-${action}`);
    haptic('medium');
    
    try {
      if (useMockData) {
        // Mock action simulation
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        setLocalApps(prev => prev.map(app => {
          if (app.id !== appId) return app;
          
          switch (action) {
            case 'start':
              return { ...app, status: 'running' };
            case 'stop':
              return { ...app, status: 'stopped', resourceUsage: { cpu: 0, memory: 0, disk: app.resourceUsage.disk } };
            case 'restart':
              return { ...app, status: 'running' };
            case 'update':
              return { ...app, version: app.newVersion, updateAvailable: false };
            default:
              return app;
          }
        }));
      } else {
        // Real API call would go here
        // The hooks would handle this, but for now we'll call directly
        const appsApi = await import('../api/apps');
        
        switch (action) {
          case 'start':
            await appsApi.startApp(appId);
            break;
          case 'stop':
            await appsApi.stopApp(appId);
            break;
          case 'restart':
            await appsApi.restartApp(appId);
            break;
          case 'update':
            await appsApi.updateApp(appId);
            break;
        }
        
        // Refresh apps list
        await refetch();
      }
    } catch (error) {
      console.error(`Failed to ${action} app:`, error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleInstallApp = async (appToInstall) => {
    haptic('medium');
    
    if (useMockData) {
      // Mock installation
      setShowInstallModal(false);
      
      const newApp = {
        id: appToInstall.id,
        name: appToInstall.name,
        description: appToInstall.description,
        status: 'stopped',
        version: '1.0.0',
        updateAvailable: false,
        url: null,
        resourceUsage: { cpu: 0, memory: 0, disk: 0 },
        installedAt: new Date().toISOString().split('T')[0],
      };
      
      setLocalApps(prev => [...prev, newApp]);
    } else {
      try {
        const result = await install(appToInstall.id, appToInstall.name);
        if (result.success) {
          setShowInstallModal(false);
          await refetch();
        }
      } catch (error) {
        console.error('Installation failed:', error);
      }
    }
  };

  const filteredApps = apps
    .filter(app => {
      if (filterStatus !== 'all' && app.status !== filterStatus) return false;
      if (searchQuery && !app.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });

  if (isLoading && !useMockData) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center animate-pulse">
          <div className="w-10 h-10 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-mono text-[var(--color-accent)]">Loading apps...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* API Error Banner */}
      {appsError && (
        <Card padding="sm" className="border-dashed animate-pulse-subtle">
          <div className="flex items-center gap-3">
            <AlertCircle size={18} className="text-[var(--color-accent)]" />
            <p className="text-sm text-[var(--color-accent)]">
              Unable to connect to API. Showing demo data.
            </p>
          </div>
        </Card>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-2xl">Apps</h1>
          <p className="text-[var(--color-accent)] mt-1">
            {apps.length} installed, {apps.filter(a => a.status === 'running').length} running
          </p>
        </div>
        
        <Button onClick={() => {
          haptic('light');
          setShowInstallModal(true);
        }}>
          <Plus size={16} />
          Install App
        </Button>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Search */}
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
        
        {/* Filter */}
        <div className="flex items-center gap-2">
          <Button
            variant={filterStatus === 'all' ? 'filled' : 'outline'}
            size="sm"
            onClick={() => setFilterStatus('all')}
          >
            All
          </Button>
          <Button
            variant={filterStatus === 'running' ? 'filled' : 'outline'}
            size="sm"
            onClick={() => setFilterStatus('running')}
          >
            Running
          </Button>
          <Button
            variant={filterStatus === 'stopped' ? 'filled' : 'outline'}
            size="sm"
            onClick={() => setFilterStatus('stopped')}
          >
            Stopped
          </Button>
        </div>

        {/* View Toggle */}
        <div className="flex items-center border-2 border-[var(--color-secondary)] rounded-full overflow-hidden">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-2 transition-colors ${viewMode === 'grid' ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' : ''}`}
          >
            <Grid size={18} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 transition-colors ${viewMode === 'list' ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' : ''}`}
          >
            <List size={18} />
          </button>
        </div>
      </div>

      {/* Apps Grid/List */}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredApps.map((app, index) => (
            <Card 
              key={app.id}
              padding="md"
              className={`animate-slide-up stagger-${Math.min(index + 1, 5)}`}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div 
                  className="cursor-pointer"
                  onClick={() => {
                    haptic('light');
                    navigate(`/apps/${app.id}`);
                  }}
                >
                  <h3 className="font-mono text-lg hover:underline">{app.name}</h3>
                  <p className="text-[var(--color-accent)] text-sm mt-1">{app.description}</p>
                </div>
                <Pill size="sm">
                  <StatusIndicator 
                    status={app.status === 'running' ? 'active' : 'inactive'} 
                    size="sm" 
                  />
                  {app.status}
                </Pill>
              </div>

              {/* Info */}
              <div className="space-y-2 mb-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--color-accent)]">Version</span>
                  <span className="font-mono">
                    {app.version}
                    {app.updateAvailable && (
                      <span className="ml-2 animate-pulse">●</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-accent)]">CPU</span>
                  <span className="font-mono">{app.resourceUsage.cpu}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-accent)]">Memory</span>
                  <span className="font-mono">{app.resourceUsage.memory}%</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-4 border-t-2 border-[var(--color-secondary)]/10">
                {app.status === 'stopped' ? (
                  <Button
                    size="sm"
                    onClick={() => handleAppAction(app.id, 'start')}
                    disabled={actionLoading === `${app.id}-start`}
                  >
                    <Play size={14} />
                    {actionLoading === `${app.id}-start` ? 'Starting...' : 'Start'}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleAppAction(app.id, 'stop')}
                      disabled={actionLoading === `${app.id}-stop`}
                    >
                      <Square size={14} />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleAppAction(app.id, 'restart')}
                      disabled={actionLoading === `${app.id}-restart`}
                    >
                      <RotateCcw size={14} />
                    </Button>
                  </>
                )}
                
                {app.url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(app.url, '_blank')}
                  >
                    <ExternalLink size={14} />
                  </Button>
                )}

                {app.updateAvailable && (
                  <Button
                    size="sm"
                    className="ml-auto animate-pulse"
                    onClick={() => handleAppAction(app.id, 'update')}
                    disabled={actionLoading === `${app.id}-update`}
                  >
                    <Download size={14} />
                    Update
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        /* List View */
        <Card padding="none">
          <div className="divide-y-2 divide-[var(--color-secondary)]/10">
            {filteredApps.map((app, index) => (
              <div 
                key={app.id}
                className={`flex items-center justify-between p-4 animate-slide-up stagger-${Math.min(index + 1, 5)}`}
              >
                <div 
                  className="flex items-center gap-4 cursor-pointer"
                  onClick={() => {
                    haptic('light');
                    navigate(`/apps/${app.id}`);
                  }}
                >
                  <StatusIndicator 
                    status={app.status === 'running' ? 'active' : 'inactive'} 
                    size="md" 
                  />
                  <div>
                    <h3 className="font-mono hover:underline">{app.name}</h3>
                    <p className="text-[var(--color-accent)] text-sm">{app.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <span className="font-mono text-sm hidden sm:block">{app.version}</span>
                  
                  <div className="flex items-center gap-2">
                    {app.status === 'stopped' ? (
                      <Button
                        size="sm"
                        onClick={() => handleAppAction(app.id, 'start')}
                        disabled={actionLoading === `${app.id}-start`}
                      >
                        <Play size={14} />
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleAppAction(app.id, 'stop')}
                        >
                          <Square size={14} />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleAppAction(app.id, 'restart')}
                        >
                          <RotateCcw size={14} />
                        </Button>
                      </>
                    )}
                    
                    {app.updateAvailable && (
                      <Button
                        size="sm"
                        className="animate-pulse"
                        onClick={() => handleAppAction(app.id, 'update')}
                      >
                        <Download size={14} />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {filteredApps.length === 0 && (
        <div className="text-center py-12">
          <p className="font-mono text-[var(--color-accent)]">
            {searchQuery ? `No apps found matching "${searchQuery}"` : 'No apps match the current filter'}
          </p>
        </div>
      )}

      {/* Install App Modal */}
      <Modal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
        title="Install New App"
        size="lg"
      >
        <p className="text-[var(--color-accent)] mb-6">
          Choose an app to install from the catalog
        </p>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {availableApps.map(app => (
            <Card 
              key={app.id}
              padding="md"
              variant="interactive"
              onClick={() => handleInstallApp(app)}
            >
              <h4 className="font-mono">{app.name}</h4>
              <p className="text-[var(--color-accent)] text-sm mt-1">{app.description}</p>
              <Pill size="sm" className="mt-3">{app.category}</Pill>
            </Card>
          ))}
        </div>
        
        {availableApps.length === 0 && (
          <p className="text-center text-[var(--color-accent)] py-8">
            All available apps are already installed
          </p>
        )}
      </Modal>
    </div>
  );
}
