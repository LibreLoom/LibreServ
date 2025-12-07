import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Search, 
  RefreshCw, 
  Clock, 
  HardDrive, 
  Cpu, 
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { Card, Button, Input, StatusIndicator, Pill } from '../components/ui';
import { useTheme } from '../context/ThemeContext';

export default function Dashboard() {
  const navigate = useNavigate();
  const { haptic } = useTheme();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [stats, setStats] = useState(null);
  const [apps, setApps] = useState([]);
  const [expandedBreakdown, setExpandedBreakdown] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      // Simulated API delay
      await new Promise(resolve => setTimeout(resolve, 600));
      
      // Mock system stats
      setStats({
        uptime: { days: 41, hours: 15, minutes: 32 },
        storage: { 
          used: 128, 
          total: 512, 
          unit: 'GB' 
        },
        resources: {
          cpu: 23,
          memory: 48,
          disk: 12,
        },
        network: {
          download: { value: 150, unit: 'MB/s' },
          upload: { value: 45, unit: 'MB/s' },
          totalIn: { value: 2.4, unit: 'TB' },
          totalOut: { value: 890, unit: 'GB' },
        },
      });

      // Mock apps
      setApps([
        {
          id: 'nextcloud',
          name: 'Nextcloud',
          status: 'running',
          resourceUsage: 35,
          version: '27.1.5',
        },
        {
          id: 'convertx',
          name: 'ConvertX',
          status: 'running',
          resourceUsage: 12,
          version: '1.2.0',
        },
        {
          id: 'searxng',
          name: 'SearXNG',
          status: 'running',
          resourceUsage: 8,
          version: '2024.1.1',
        },
        {
          id: 'vaultwarden',
          name: 'Vaultwarden',
          status: 'stopped',
          resourceUsage: 0,
          version: '1.30.0',
        },
        {
          id: 'jellyfin',
          name: 'Jellyfin',
          status: 'running',
          resourceUsage: 28,
          version: '10.8.13',
        },
      ]);
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    haptic('medium');
    await loadData();
    setIsRefreshing(false);
  };

  const filteredApps = apps.filter(app =>
    app.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center animate-pulse">
          <div className="w-10 h-10 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-mono text-[var(--color-accent)]">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Uptime */}
        <Card padding="md" className="animate-slide-up stagger-1">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-[var(--color-secondary)]/10">
              <Clock size={20} />
            </div>
            <div>
              <p className="text-[var(--color-accent)] text-sm">Uptime</p>
              <p className="font-mono text-2xl mt-1">
                {stats?.uptime.days}d {stats?.uptime.hours}h
              </p>
            </div>
          </div>
        </Card>

        {/* Storage */}
        <Card padding="md" className="animate-slide-up stagger-2">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-[var(--color-secondary)]/10">
              <HardDrive size={20} />
            </div>
            <div className="flex-1">
              <p className="text-[var(--color-accent)] text-sm">Storage</p>
              <p className="font-mono text-2xl mt-1">
                {stats?.storage.used}/{stats?.storage.total}{stats?.storage.unit}
              </p>
              {/* Progress bar */}
              <div className="mt-2 h-1.5 rounded-full bg-[var(--color-secondary)]/20">
                <div 
                  className="h-full rounded-full bg-[var(--color-secondary)] transition-all duration-500"
                  style={{ width: `${(stats?.storage.used / stats?.storage.total) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </Card>

        {/* CPU */}
        <Card padding="md" className="animate-slide-up stagger-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-[var(--color-secondary)]/10">
              <Cpu size={20} />
            </div>
            <div className="flex-1">
              <p className="text-[var(--color-accent)] text-sm">CPU Usage</p>
              <p className="font-mono text-2xl mt-1">{stats?.resources.cpu}%</p>
              <div className="mt-2 h-1.5 rounded-full bg-[var(--color-secondary)]/20">
                <div 
                  className="h-full rounded-full bg-[var(--color-secondary)] transition-all duration-500"
                  style={{ width: `${stats?.resources.cpu}%` }}
                />
              </div>
            </div>
          </div>
        </Card>

        {/* Memory */}
        <Card padding="md" className="animate-slide-up stagger-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-[var(--color-secondary)]/10">
              <Activity size={20} />
            </div>
            <div className="flex-1">
              <p className="text-[var(--color-accent)] text-sm">Memory</p>
              <p className="font-mono text-2xl mt-1">{stats?.resources.memory}%</p>
              <div className="mt-2 h-1.5 rounded-full bg-[var(--color-secondary)]/20">
                <div 
                  className="h-full rounded-full bg-[var(--color-secondary)] transition-all duration-500"
                  style={{ width: `${stats?.resources.memory}%` }}
                />
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Network Stats */}
      <Card padding="md" className="animate-slide-up stagger-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-mono text-lg">Network Usage</h3>
          <button
            onClick={() => setExpandedBreakdown(!expandedBreakdown)}
            className="p-1 rounded-full hover:bg-[var(--color-secondary)]/10 transition-colors"
          >
            {expandedBreakdown ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Download Speed */}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-[var(--color-secondary)]/10">
              <ArrowDown size={18} />
            </div>
            <div>
              <p className="text-[var(--color-accent)] text-xs">Download</p>
              <p className="font-mono text-lg">
                {stats?.network.download.value} {stats?.network.download.unit}
              </p>
            </div>
          </div>

          {/* Upload Speed */}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-[var(--color-secondary)]/10">
              <ArrowUp size={18} />
            </div>
            <div>
              <p className="text-[var(--color-accent)] text-xs">Upload</p>
              <p className="font-mono text-lg">
                {stats?.network.upload.value} {stats?.network.upload.unit}
              </p>
            </div>
          </div>

          {/* Total In */}
          <div className="flex items-center gap-3">
            <div>
              <p className="text-[var(--color-accent)] text-xs">Total In</p>
              <p className="font-mono text-lg">
                {stats?.network.totalIn.value} {stats?.network.totalIn.unit}
              </p>
            </div>
          </div>

          {/* Total Out */}
          <div className="flex items-center gap-3">
            <div>
              <p className="text-[var(--color-accent)] text-xs">Total Out</p>
              <p className="font-mono text-lg">
                {stats?.network.totalOut.value} {stats?.network.totalOut.unit}
              </p>
            </div>
          </div>
        </div>

        {/* Expanded breakdown */}
        {expandedBreakdown && (
          <div className="mt-4 pt-4 border-t-2 border-[var(--color-secondary)]/10 animate-slide-down">
            <p className="text-[var(--color-accent)] text-sm mb-3">Per-App Network Usage</p>
            <div className="space-y-2">
              {apps.filter(a => a.status === 'running').map(app => (
                <div key={app.id} className="flex items-center justify-between py-2">
                  <span className="font-mono text-sm">{app.name}</span>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="flex items-center gap-1">
                      <ArrowDown size={12} />
                      {Math.floor(Math.random() * 50 + 10)} MB/s
                    </span>
                    <span className="flex items-center gap-1">
                      <ArrowUp size={12} />
                      {Math.floor(Math.random() * 20 + 5)} MB/s
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Apps Section */}
      <div>
        <div className="flex items-center gap-4 mb-4">
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
          
          {/* Refresh */}
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
          </Button>
        </div>

        {/* App Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredApps.map((app, index) => (
            <Card 
              key={app.id}
              padding="md"
              variant="interactive"
              onClick={() => {
                haptic('light');
                navigate(`/apps/${app.id}`);
              }}
              className={`animate-slide-up stagger-${Math.min(index + 1, 5)}`}
            >
              <div className="flex items-start justify-between mb-4">
                <h4 className="font-mono text-lg">{app.name}</h4>
                <Pill size="sm">
                  <StatusIndicator 
                    status={app.status === 'running' ? 'active' : 'inactive'} 
                    size="sm" 
                  />
                  {app.status}
                </Pill>
              </div>
              
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[var(--color-accent)]">Version</span>
                  <span className="font-mono">{app.version}</span>
                </div>
                
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[var(--color-accent)]">Resources</span>
                  <span className="font-mono">{app.resourceUsage}%</span>
                </div>
                
                {/* Resource bar */}
                <div className="h-1 rounded-full bg-[var(--color-secondary)]/20">
                  <div 
                    className="h-full rounded-full bg-[var(--color-secondary)] transition-all duration-500"
                    style={{ width: `${app.resourceUsage}%` }}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>

        {filteredApps.length === 0 && (
          <div className="text-center py-12">
            <p className="font-mono text-[var(--color-accent)]">
              {searchQuery 
                ? `No apps found matching "${searchQuery}"`
                : 'No apps installed yet'
              }
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
