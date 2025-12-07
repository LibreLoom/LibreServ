import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft,
  Play,
  Square,
  RefreshCw,
  Download,
  Trash2,
  Terminal,
  Activity,
  HardDrive,
  Cpu,
  MemoryStick,
  Network,
  Clock,
  ExternalLink,
  Settings,
  ChevronDown,
  ChevronUp,
  AlertCircle
} from 'lucide-react';
import { Card, Button, Input, Pill, StatusIndicator, Modal } from '../components/ui';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

// Mock app data
const MOCK_APPS = {
  nextcloud: {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Self-hosted productivity platform',
    version: '28.0.1',
    status: 'running',
    url: 'https://cloud.example.com',
    image: 'nextcloud:28',
    created: '2024-01-15T10:30:00Z',
    updated: '2024-03-01T14:20:00Z',
    metrics: {
      cpu: 12,
      memory: 45,
      storage: 128,
      storageTotal: 500,
      networkIn: '2.3 GB',
      networkOut: '890 MB',
      uptime: '15d 4h 32m',
      requests: '1.2k/min',
    },
    containers: [
      { name: 'nextcloud-app', status: 'running', cpu: 8, memory: 35 },
      { name: 'nextcloud-db', status: 'running', cpu: 4, memory: 10 },
      { name: 'nextcloud-redis', status: 'running', cpu: 0.5, memory: 2 },
    ],
    ports: [
      { internal: 80, external: 8080, protocol: 'tcp' },
      { internal: 443, external: 8443, protocol: 'tcp' },
    ],
    volumes: [
      { name: 'nextcloud_data', mountPath: '/var/www/html', size: '128 GB' },
      { name: 'nextcloud_db', mountPath: '/var/lib/mysql', size: '12 GB' },
    ],
    env: [
      { key: 'NEXTCLOUD_ADMIN_USER', value: 'admin', secret: false },
      { key: 'NEXTCLOUD_ADMIN_PASSWORD', value: '********', secret: true },
      { key: 'MYSQL_HOST', value: 'nextcloud-db', secret: false },
    ],
  },
  jellyfin: {
    id: 'jellyfin',
    name: 'Jellyfin',
    description: 'Media streaming server',
    version: '10.8.13',
    status: 'running',
    url: 'https://media.example.com',
    image: 'jellyfin/jellyfin:10.8.13',
    created: '2024-02-01T08:00:00Z',
    updated: '2024-02-28T16:45:00Z',
    metrics: {
      cpu: 35,
      memory: 28,
      storage: 2048,
      storageTotal: 4000,
      networkIn: '450 GB',
      networkOut: '12 TB',
      uptime: '8d 12h 15m',
      requests: '45/min',
    },
    containers: [
      { name: 'jellyfin', status: 'running', cpu: 35, memory: 28 },
    ],
    ports: [
      { internal: 8096, external: 8096, protocol: 'tcp' },
      { internal: 8920, external: 8920, protocol: 'tcp' },
    ],
    volumes: [
      { name: 'jellyfin_config', mountPath: '/config', size: '2 GB' },
      { name: 'media_library', mountPath: '/media', size: '2 TB' },
    ],
    env: [
      { key: 'JELLYFIN_PublishedServerUrl', value: 'https://media.example.com', secret: false },
    ],
  },
  vaultwarden: {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    description: 'Password manager',
    version: '1.30.1',
    status: 'stopped',
    url: 'https://vault.example.com',
    image: 'vaultwarden/server:1.30.1',
    created: '2024-01-20T12:00:00Z',
    updated: '2024-02-15T09:30:00Z',
    metrics: {
      cpu: 0,
      memory: 0,
      storage: 1,
      storageTotal: 10,
      networkIn: '0 B',
      networkOut: '0 B',
      uptime: '0',
      requests: '0/min',
    },
    containers: [
      { name: 'vaultwarden', status: 'stopped', cpu: 0, memory: 0 },
    ],
    ports: [
      { internal: 80, external: 8000, protocol: 'tcp' },
    ],
    volumes: [
      { name: 'vaultwarden_data', mountPath: '/data', size: '1 GB' },
    ],
    env: [
      { key: 'DOMAIN', value: 'https://vault.example.com', secret: false },
      { key: 'ADMIN_TOKEN', value: '********', secret: true },
    ],
  },
};

export default function AppDetail() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const { haptic } = useTheme();
  const { hasPermission } = useAuth();
  
  const [app, setApp] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isActionLoading, setIsActionLoading] = useState(false);

  useEffect(() => {
    loadApp();
  }, [appId]);

  const loadApp = async () => {
    setIsLoading(true);
    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const appData = MOCK_APPS[appId];
      if (appData) {
        setApp(appData);
        // Generate some mock logs
        setLogs([
          { time: '2024-03-01 14:20:15', level: 'info', message: 'Container started successfully' },
          { time: '2024-03-01 14:20:14', level: 'info', message: 'Pulling image nextcloud:28...' },
          { time: '2024-03-01 14:20:10', level: 'info', message: 'Starting container nextcloud-app' },
          { time: '2024-03-01 14:20:05', level: 'warn', message: 'Previous container stopped unexpectedly' },
          { time: '2024-03-01 14:19:58', level: 'info', message: 'Health check passed' },
          { time: '2024-03-01 14:19:50', level: 'info', message: 'Database connection established' },
        ]);
      }
    } catch (error) {
      console.error('Failed to load app:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = async (action) => {
    haptic('medium');
    setIsActionLoading(true);
    
    // Simulate action
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    if (action === 'start') {
      setApp(prev => ({ ...prev, status: 'running' }));
    } else if (action === 'stop') {
      setApp(prev => ({ ...prev, status: 'stopped' }));
    } else if (action === 'restart') {
      setApp(prev => ({ ...prev, status: 'running' }));
    }
    
    setIsActionLoading(false);
  };

  const handleDelete = async () => {
    if (deleteConfirmText !== app.name) return;
    
    haptic('heavy');
    setShowDeleteModal(false);
    
    // Simulate deletion
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    navigate('/apps');
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center animate-pulse">
          <div className="w-10 h-10 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-mono text-[var(--color-accent)]">Loading app...</p>
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <AlertCircle size={48} className="text-[var(--color-accent)]" />
        <h1 className="font-mono text-xl">App Not Found</h1>
        <p className="text-[var(--color-accent)]">
          The app "{appId}" does not exist or you don't have access.
        </p>
        <Button onClick={() => navigate('/apps')}>
          <ArrowLeft size={16} />
          Back to Apps
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate('/apps')}>
            <ArrowLeft size={20} />
          </Button>
          
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-mono text-2xl">{app.name}</h1>
              <StatusIndicator status={app.status} />
            </div>
            <p className="text-[var(--color-accent)] mt-1">{app.description}</p>
          </div>
        </div>

        {app.url && (
          <Button 
            variant="outline"
            onClick={() => {
              haptic('light');
              window.open(app.url, '_blank');
            }}
          >
            <ExternalLink size={16} />
            Open
          </Button>
        )}
      </div>

      {/* Quick Actions */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {app.status === 'running' ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleAction('stop')}
                  disabled={isActionLoading}
                >
                  <Square size={16} />
                  Stop
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleAction('restart')}
                  disabled={isActionLoading}
                >
                  <RefreshCw size={16} className={isActionLoading ? 'animate-spin' : ''} />
                  Restart
                </Button>
              </>
            ) : (
              <Button
                onClick={() => handleAction('start')}
                disabled={isActionLoading}
              >
                <Play size={16} />
                Start
              </Button>
            )}
            
            <Button variant="outline" disabled={isActionLoading}>
              <Download size={16} />
              Update
            </Button>
          </div>

          <div className="flex items-center gap-4 text-sm text-[var(--color-accent)]">
            <span className="font-mono">v{app.version}</span>
            <span>•</span>
            <span>Image: {app.image}</span>
          </div>
        </div>
      </Card>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card padding="md">
          <div className="flex items-center gap-3">
            <Cpu size={20} className="text-[var(--color-accent)]" />
            <div>
              <p className="font-mono text-xl">{app.metrics.cpu}%</p>
              <p className="text-[var(--color-accent)] text-sm">CPU Usage</p>
            </div>
          </div>
          <div className="mt-3 h-2 bg-[var(--color-secondary)]/10 rounded-full overflow-hidden">
            <div 
              className="h-full bg-[var(--color-secondary)] rounded-full transition-all duration-500"
              style={{ width: `${app.metrics.cpu}%` }}
            />
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-center gap-3">
            <MemoryStick size={20} className="text-[var(--color-accent)]" />
            <div>
              <p className="font-mono text-xl">{app.metrics.memory}%</p>
              <p className="text-[var(--color-accent)] text-sm">Memory</p>
            </div>
          </div>
          <div className="mt-3 h-2 bg-[var(--color-secondary)]/10 rounded-full overflow-hidden">
            <div 
              className="h-full bg-[var(--color-secondary)] rounded-full transition-all duration-500"
              style={{ width: `${app.metrics.memory}%` }}
            />
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-center gap-3">
            <HardDrive size={20} className="text-[var(--color-accent)]" />
            <div>
              <p className="font-mono text-xl">{app.metrics.storage} GB</p>
              <p className="text-[var(--color-accent)] text-sm">
                of {app.metrics.storageTotal} GB
              </p>
            </div>
          </div>
          <div className="mt-3 h-2 bg-[var(--color-secondary)]/10 rounded-full overflow-hidden">
            <div 
              className="h-full bg-[var(--color-secondary)] rounded-full transition-all duration-500"
              style={{ width: `${(app.metrics.storage / app.metrics.storageTotal) * 100}%` }}
            />
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-center gap-3">
            <Clock size={20} className="text-[var(--color-accent)]" />
            <div>
              <p className="font-mono text-xl">{app.metrics.uptime || 'N/A'}</p>
              <p className="text-[var(--color-accent)] text-sm">Uptime</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Network Stats */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Network size={20} />
          Network
        </h2>
        
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="font-mono text-xl">{app.metrics.networkIn}</p>
            <p className="text-[var(--color-accent)] text-sm">Total In</p>
          </div>
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="font-mono text-xl">{app.metrics.networkOut}</p>
            <p className="text-[var(--color-accent)] text-sm">Total Out</p>
          </div>
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="font-mono text-xl">{app.metrics.requests}</p>
            <p className="text-[var(--color-accent)] text-sm">Requests</p>
          </div>
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="font-mono text-xl">{app.ports.length}</p>
            <p className="text-[var(--color-accent)] text-sm">Open Ports</p>
          </div>
        </div>

        {/* Ports */}
        <div className="mt-4">
          <h3 className="font-mono text-sm text-[var(--color-accent)] mb-2">Port Mappings</h3>
          <div className="flex flex-wrap gap-2">
            {app.ports.map((port, i) => (
              <Pill key={i} size="sm">
                {port.external}:{port.internal}/{port.protocol}
              </Pill>
            ))}
          </div>
        </div>
      </Card>

      {/* Containers */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Activity size={20} />
          Containers
        </h2>
        
        <div className="space-y-3">
          {app.containers.map((container, i) => (
            <div 
              key={i}
              className="flex items-center justify-between p-3 bg-[var(--color-secondary)]/5 rounded-2xl"
            >
              <div className="flex items-center gap-3">
                <StatusIndicator status={container.status} />
                <span className="font-mono">{container.name}</span>
              </div>
              
              <div className="flex items-center gap-4 text-sm">
                <span>CPU: {container.cpu}%</span>
                <span>RAM: {container.memory}%</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Volumes */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <HardDrive size={20} />
          Volumes
        </h2>
        
        <div className="space-y-3">
          {app.volumes.map((volume, i) => (
            <div 
              key={i}
              className="flex items-center justify-between p-3 bg-[var(--color-secondary)]/5 rounded-2xl"
            >
              <div>
                <p className="font-mono">{volume.name}</p>
                <p className="text-[var(--color-accent)] text-sm">{volume.mountPath}</p>
              </div>
              <Pill size="sm">{volume.size}</Pill>
            </div>
          ))}
        </div>
      </Card>

      {/* Environment Variables */}
      <Card>
        <button
          onClick={() => {
            haptic('light');
            setShowEnv(!showEnv);
          }}
          className="w-full flex items-center justify-between"
        >
          <h2 className="font-mono text-lg flex items-center gap-2">
            <Settings size={20} />
            Environment Variables
          </h2>
          {showEnv ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
        
        {showEnv && (
          <div className="mt-4 space-y-2 animate-slide-down">
            {app.env.map((env, i) => (
              <div 
                key={i}
                className="flex items-center justify-between p-3 bg-[var(--color-secondary)]/5 rounded-2xl font-mono text-sm"
              >
                <span>{env.key}</span>
                <span className="text-[var(--color-accent)]">
                  {env.secret ? '••••••••' : env.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Logs */}
      <Card>
        <button
          onClick={() => {
            haptic('light');
            setShowLogs(!showLogs);
          }}
          className="w-full flex items-center justify-between"
        >
          <h2 className="font-mono text-lg flex items-center gap-2">
            <Terminal size={20} />
            Recent Logs
          </h2>
          {showLogs ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
        
        {showLogs && (
          <div className="mt-4 animate-slide-down">
            <div className="bg-[var(--color-secondary)]/5 rounded-2xl p-4 font-mono text-sm max-h-64 overflow-auto">
              {logs.map((log, i) => (
                <div key={i} className="flex gap-4 py-1">
                  <span className="text-[var(--color-accent)] whitespace-nowrap">
                    {log.time}
                  </span>
                  <span className={`
                    uppercase text-xs px-2 py-0.5 rounded
                    ${log.level === 'warn' ? 'bg-[var(--color-secondary)]/20' : ''}
                  `}>
                    {log.level}
                  </span>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Info */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Information</h2>
        
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-[var(--color-accent)]">Created</p>
            <p className="font-mono">{formatDate(app.created)}</p>
          </div>
          <div>
            <p className="text-[var(--color-accent)]">Last Updated</p>
            <p className="font-mono">{formatDate(app.updated)}</p>
          </div>
          <div>
            <p className="text-[var(--color-accent)]">Image</p>
            <p className="font-mono">{app.image}</p>
          </div>
          <div>
            <p className="text-[var(--color-accent)]">Version</p>
            <p className="font-mono">{app.version}</p>
          </div>
        </div>
      </Card>

      {/* Danger Zone */}
      <Card className="border-dashed">
        <h2 className="font-mono text-lg mb-2 flex items-center gap-2">
          <AlertCircle size={20} />
          Danger Zone
        </h2>
        <p className="text-[var(--color-accent)] text-sm mb-4">
          Destructive actions that cannot be undone
        </p>

        <Button 
          variant="outline"
          onClick={() => {
            haptic('medium');
            setShowDeleteModal(true);
          }}
        >
          <Trash2 size={16} />
          Delete App
        </Button>
      </Card>

      {/* Delete Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setDeleteConfirmText('');
        }}
        title="Delete App"
      >
        <div className="space-y-4">
          <div className="p-4 border-2 border-dashed border-[var(--color-secondary)] rounded-2xl animate-pulse-slow">
            <p className="font-mono text-sm mb-2">Warning</p>
            <p className="text-[var(--color-accent)] text-sm">
              This will permanently delete {app.name} and all its data including:
            </p>
            <ul className="text-[var(--color-accent)] text-sm mt-2 ml-4 list-disc">
              <li>All containers ({app.containers.length})</li>
              <li>All volumes ({app.volumes.length})</li>
              <li>Configuration and environment variables</li>
            </ul>
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">
              Type "{app.name}" to confirm
            </label>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={app.name}
              className="font-mono"
            />
          </div>

          <div className="flex gap-3">
            <Button 
              onClick={handleDelete}
              disabled={deleteConfirmText !== app.name}
              className="flex-1"
            >
              <Trash2 size={16} />
              Delete App
            </Button>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowDeleteModal(false);
                setDeleteConfirmText('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
