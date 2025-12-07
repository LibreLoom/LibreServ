import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, Play, Square, RotateCcw, Trash2, ExternalLink, 
  Activity, HardDrive, Cpu, Clock, Download, Upload, Settings,
  ChevronDown, ChevronUp
} from 'lucide-react';
import { Card, Button, Pill, StatusDot } from '../components/ui';
import { appsApi } from '../api';

const AppDetail = () => {
  const { appId } = useParams();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    loadApp();
  }, [appId]);

  const loadApp = async () => {
    setIsLoading(true);
    try {
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Mock data
      setApp({
        id: appId,
        name: appId.charAt(0).toUpperCase() + appId.slice(1),
        status: 'running',
        type: 'builtin',
        version: '27.1.5',
        url: `https://${appId}.local`,
        installedAt: new Date(Date.now() - 86400000 * 30).toISOString(),
        lastUpdated: new Date(Date.now() - 86400000 * 7).toISOString(),
        updateAvailable: true,
        newVersion: '28.0.0',
        metrics: {
          cpu: 23,
          memory: { used: 512, total: 1024 },
          disk: { used: 2.5, total: 10 },
          network: { rx: 150, tx: 45 },
          uptime: 604800, // 7 days in seconds
        },
        containers: [
          { name: `${appId}-app`, status: 'running', image: `${appId}/app:latest` },
          { name: `${appId}-db`, status: 'running', image: 'postgres:15' },
          { name: `${appId}-redis`, status: 'running', image: 'redis:7' },
        ],
      });

      // Mock logs
      setLogs([
        { timestamp: new Date().toISOString(), level: 'info', message: 'Application started successfully' },
        { timestamp: new Date(Date.now() - 60000).toISOString(), level: 'info', message: 'Database connection established' },
        { timestamp: new Date(Date.now() - 120000).toISOString(), level: 'warn', message: 'High memory usage detected' },
        { timestamp: new Date(Date.now() - 180000).toISOString(), level: 'info', message: 'Cache cleared' },
        { timestamp: new Date(Date.now() - 240000).toISOString(), level: 'error', message: 'Failed to connect to external service (retry 1/3)' },
        { timestamp: new Date(Date.now() - 300000).toISOString(), level: 'info', message: 'External service connection restored' },
      ]);
    } catch (error) {
      console.error('Failed to load app:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = async (action) => {
    setActionLoading(action);
    try {
      // TODO: Replace with actual API calls
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      switch (action) {
        case 'start':
          setApp(prev => ({ ...prev, status: 'running' }));
          break;
        case 'stop':
          setApp(prev => ({ ...prev, status: 'stopped' }));
          break;
        case 'restart':
          setApp(prev => ({ ...prev, status: 'running' }));
          break;
        case 'update':
          setApp(prev => ({ 
            ...prev, 
            version: prev.newVersion, 
            updateAvailable: false,
            lastUpdated: new Date().toISOString(),
          }));
          break;
        case 'delete':
          if (confirm(`Are you sure you want to delete ${app.name}? This will remove all data.`)) {
            navigate('/');
          }
          return;
      }
    } catch (error) {
      alert(`Failed to ${action} app`);
    } finally {
      setActionLoading(null);
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatUptime = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const getLogLevelStyle = (level) => {
    // Simplex Mono: No semantic colors, use only accent/secondary
    // Differentiate by text decoration/style instead
    const styles = {
      info: 'text-[var(--color-accent)]',
      warn: 'text-[var(--color-secondary)] font-bold',
      error: 'text-[var(--color-secondary)] font-bold underline',
      debug: 'text-[var(--color-accent)] italic',
    };
    return styles[level] || styles.info;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-mono text-[var(--color-accent)]">Loading app...</p>
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="text-center py-12">
        <p className="font-mono text-xl mb-4">App not found</p>
        <Button onClick={() => navigate('/')}>
          <ArrowLeft size={16} />
          Back to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/')}
          className="p-2 hover:bg-[var(--color-secondary)]/10 rounded-full transition-colors"
        >
          <ArrowLeft size={24} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl">{app.name}</h1>
            <Pill size="sm">
              <StatusDot status={app.status === 'running' ? 'active' : 'inactive'} />
              {app.status}
            </Pill>
          </div>
          <p className="text-[var(--color-accent)]">
            Version {app.version}
            {app.updateAvailable && (
              <span className="ml-2 animate-pulse">
                ● Update to {app.newVersion} available
              </span>
            )}
          </p>
        </div>
        {app.url && (
          <Button variant="outline" onClick={() => window.open(app.url, '_blank')}>
            <ExternalLink size={16} />
            Open App
          </Button>
        )}
      </div>

      {/* Action Buttons */}
      <Card>
        <div className="flex flex-wrap gap-3">
          {app.status === 'stopped' ? (
            <Button 
              onClick={() => handleAction('start')}
              disabled={actionLoading === 'start'}
            >
              <Play size={16} />
              {actionLoading === 'start' ? 'Starting...' : 'Start'}
            </Button>
          ) : (
            <Button 
              variant="outline"
              onClick={() => handleAction('stop')}
              disabled={actionLoading === 'stop'}
            >
              <Square size={16} />
              {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
            </Button>
          )}
          
          <Button 
            variant="outline"
            onClick={() => handleAction('restart')}
            disabled={actionLoading === 'restart' || app.status === 'stopped'}
          >
            <RotateCcw size={16} />
            {actionLoading === 'restart' ? 'Restarting...' : 'Restart'}
          </Button>

          {app.updateAvailable && (
            <Button 
              onClick={() => handleAction('update')}
              disabled={actionLoading === 'update'}
              className="animate-pulse"
            >
              <Download size={16} />
              {actionLoading === 'update' ? 'Updating...' : `Update to ${app.newVersion}`}
            </Button>
          )}

          <Button 
            variant="outline"
            className="border-dashed ml-auto"
            onClick={() => handleAction('delete')}
            disabled={actionLoading === 'delete'}
          >
            <Trash2 size={16} />
            Delete
          </Button>
        </div>
      </Card>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="text-center">
          <Cpu size={24} className="mx-auto mb-2 text-[var(--color-accent)]" />
          <p className="font-mono text-2xl">{app.metrics.cpu}%</p>
          <p className="text-[var(--color-accent)] text-sm">CPU Usage</p>
        </Card>
        
        <Card className="text-center">
          <Activity size={24} className="mx-auto mb-2 text-[var(--color-accent)]" />
          <p className="font-mono text-2xl">
            {Math.round(app.metrics.memory.used / app.metrics.memory.total * 100)}%
          </p>
          <p className="text-[var(--color-accent)] text-sm">
            {app.metrics.memory.used}MB / {app.metrics.memory.total}MB
          </p>
        </Card>
        
        <Card className="text-center">
          <HardDrive size={24} className="mx-auto mb-2 text-[var(--color-accent)]" />
          <p className="font-mono text-2xl">{app.metrics.disk.used}GB</p>
          <p className="text-[var(--color-accent)] text-sm">
            of {app.metrics.disk.total}GB used
          </p>
        </Card>
        
        <Card className="text-center">
          <Clock size={24} className="mx-auto mb-2 text-[var(--color-accent)]" />
          <p className="font-mono text-2xl">{formatUptime(app.metrics.uptime)}</p>
          <p className="text-[var(--color-accent)] text-sm">Uptime</p>
        </Card>
      </div>

      {/* Network Stats */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Network</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center gap-3">
            <Download size={20} className="text-[var(--color-accent)]" />
            <div>
              <p className="font-mono">{app.metrics.network.rx} MB/s</p>
              <p className="text-[var(--color-accent)] text-sm">Download</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Upload size={20} className="text-[var(--color-accent)]" />
            <div>
              <p className="font-mono">{app.metrics.network.tx} MB/s</p>
              <p className="text-[var(--color-accent)] text-sm">Upload</p>
            </div>
          </div>
        </div>
      </Card>

      {/* Containers */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Containers</h2>
        <div className="space-y-3">
          {app.containers.map((container, index) => (
            <div 
              key={index}
              className="flex items-center justify-between p-3 bg-[var(--color-secondary)]/5 rounded-xl"
            >
              <div>
                <p className="font-mono">{container.name}</p>
                <p className="text-[var(--color-accent)] text-sm">{container.image}</p>
              </div>
              <Pill size="sm">
                <StatusDot status={container.status === 'running' ? 'active' : 'attention'} />
                {container.status}
              </Pill>
            </div>
          ))}
        </div>
      </Card>

      {/* Logs */}
      <Card>
        <button
          onClick={() => setShowLogs(!showLogs)}
          className="w-full flex items-center justify-between"
        >
          <h2 className="font-mono text-lg">Logs</h2>
          {showLogs ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
        
        {showLogs && (
          <div className="mt-4 p-4 bg-black/50 rounded-xl overflow-auto max-h-64">
            <pre className="font-mono text-sm space-y-1">
              {logs.map((log, index) => (
                <div key={index} className="flex gap-4">
                  <span className="text-[var(--color-accent)] shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`${getLogLevelStyle(log.level)} shrink-0 w-12`}>
                    [{log.level.toUpperCase()}]
                  </span>
                  <span className="text-[var(--color-secondary)]">
                    {log.message}
                  </span>
                </div>
              ))}
            </pre>
          </div>
        )}
      </Card>

      {/* Info */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Information</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-[var(--color-accent)]">Type</p>
            <p className="font-mono capitalize">{app.type}</p>
          </div>
          <div>
            <p className="text-[var(--color-accent)]">Installed</p>
            <p className="font-mono">{new Date(app.installedAt).toLocaleDateString()}</p>
          </div>
          <div>
            <p className="text-[var(--color-accent)]">Last Updated</p>
            <p className="font-mono">{new Date(app.lastUpdated).toLocaleDateString()}</p>
          </div>
          <div>
            <p className="text-[var(--color-accent)]">App ID</p>
            <p className="font-mono">{app.id}</p>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default AppDetail;
