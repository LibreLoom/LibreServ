import { useState, useEffect } from 'react';
import {
  Globe,
  Wifi,
  Shield,
  Settings,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  Copy,
  Plus,
  Trash2,
  Edit
} from 'lucide-react';
import { Card, Button, Input, Pill, StatusIndicator, Modal } from '../components/ui';
import { useTheme } from '../context/ThemeContext';
import { api } from '../api/client';

export default function Network() {
  const { haptic } = useTheme();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Domain configuration
  const [domainConfig, setDomainConfig] = useState({
    defaultDomain: '',
    sslEmail: '',
    autoHTTPS: true
  });
  
  // Port forwarding status
  const [portForwardingStatus, setPortForwardingStatus] = useState({
    externalIP: '',
    requiredPorts: [80, 443, 8080],
    isConfigured: false,
    suggestions: []
  });
  
  // Routes
  const [routes, setRoutes] = useState([]);
  const [showAddRoute, setShowAddRoute] = useState(false);
  const [newRoute, setNewRoute] = useState({
    subdomain: '',
    backend: '',
    appId: ''
  });

  // Caddy status
  const [caddyStatus, setCaddyStatus] = useState({
    running: false,
    version: '',
    configValid: false,
    routes: 0,
    domains: []
  });

  useEffect(() => {
    loadNetworkStatus();
    loadRoutes();
    loadCaddyStatus();
  }, []);

  const loadNetworkStatus = async () => {
    try {
      // Load domain configuration
      const domainResponse = await api.get('/api/v1/network/domain');
      if (domainResponse) {
        setDomainConfig(domainResponse);
      }
    } catch (err) {
      console.warn('Could not load domain config:', err);
    }

    try {
      // Load port forwarding status
      const portResponse = await api.get('/api/v1/network/port-forwarding-status');
      if (portResponse) {
        setPortForwardingStatus(portResponse);
      }
    } catch (err) {
      console.warn('Could not load port forwarding status:', err);
    }
  };

  const loadRoutes = async () => {
    try {
      const response = await api.get('/api/v1/network/routes');
      setRoutes(response.routes || []);
    } catch (err) {
      console.warn('Could not load routes:', err);
    }
  };

  const loadCaddyStatus = async () => {
    try {
      const response = await api.get('/api/v1/network/status');
      setCaddyStatus(response);
    } catch (err) {
      console.warn('Could not load Caddy status:', err);
    }
  };

  const saveDomainConfig = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await api.post('/api/v1/network/domain', domainConfig);
      await loadNetworkStatus();
      haptic('medium');
    } catch (err) {
      setError(err.message || 'Failed to save domain configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const addRoute = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await api.post('/api/v1/network/routes', newRoute);
      setShowAddRoute(false);
      setNewRoute({ subdomain: '', backend: '', appId: '' });
      await loadRoutes();
      haptic('medium');
    } catch (err) {
      setError(err.message || 'Failed to add route');
    } finally {
      setIsLoading(false);
    }
  };

  const deleteRoute = async (routeId) => {
    setIsLoading(true);
    setError(null);

    try {
      await api.delete(`/api/v1/network/routes/${routeId}`);
      await loadRoutes();
      haptic('medium');
    } catch (err) {
      setError(err.message || 'Failed to delete route');
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    haptic('light');
  };

  const getPortStatus = (port) => {
    // Simulate port status check
    return Math.random() > 0.5 ? 'open' : 'closed';
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-mono text-2xl">Network Configuration</h1>
        <p className="text-[var(--color-accent)] mt-1">
          Configure domain, SSL, and routing for your apps
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <Card className="border-red-500/20 bg-red-500/5">
          <div className="flex items-center gap-3 text-red-400">
            <AlertCircle size={20} />
            <span>{error}</span>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setError(null)}
              className="ml-auto"
            >
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      {/* Caddy Status */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Settings size={20} />
          Reverse Proxy Status
        </h2>
        
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="text-center">
            <StatusIndicator 
              status={caddyStatus.running ? 'active' : 'inactive'} 
              size="md" 
            />
            <p className="font-mono text-sm mt-2">
              {caddyStatus.running ? 'Running' : 'Stopped'}
            </p>
          </div>
          
          <div className="text-center">
            <p className="font-mono text-lg">{caddyStatus.routes || 0}</p>
            <p className="text-[var(--color-accent)] text-sm">Routes</p>
          </div>
          
          <div className="text-center">
            <p className="font-mono text-lg">
              {caddyStatus.configValid ? 'Valid' : 'Invalid'}
            </p>
            <p className="text-[var(--color-accent)] text-sm">Configuration</p>
          </div>
          
          <div className="text-center">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => loadCaddyStatus()}
            >
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {/* Domain Configuration */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Globe size={20} />
          Domain Configuration
        </h2>
        
        <div className="space-y-4 max-w-2xl">
          <div>
            <label className="block text-sm font-mono mb-2">Default Domain</label>
            <Input
              placeholder="example.com"
              value={domainConfig.defaultDomain}
              onChange={(e) => setDomainConfig({...domainConfig, defaultDomain: e.target.value})}
            />
            <p className="text-sm text-[var(--color-accent)] mt-1">
              Apps will be accessible as subdomain.example.com
            </p>
          </div>

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={domainConfig.autoHTTPS}
                onChange={(e) => setDomainConfig({...domainConfig, autoHTTPS: e.target.checked})}
                className="w-4 h-4"
              />
              <div>
                <span className="font-mono text-sm">Automatic HTTPS</span>
                <p className="text-sm text-[var(--color-accent)]">
                  Enable free SSL certificates from Let's Encrypt
                </p>
              </div>
            </label>
          </div>

          {domainConfig.autoHTTPS && (
            <div>
              <label className="block text-sm font-mono mb-2">SSL Certificate Email</label>
              <Input
                type="email"
                placeholder="admin@example.com"
                value={domainConfig.sslEmail}
                onChange={(e) => setDomainConfig({...domainConfig, sslEmail: e.target.value})}
              />
            </div>
          )}

          <Button 
            onClick={saveDomainConfig}
            disabled={isLoading}
          >
            {isLoading ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      </Card>

      {/* Port Forwarding Status */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Wifi size={20} />
          Port Forwarding Status
        </h2>
        
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div>
              <p className="font-mono text-sm">External IP:</p>
              <p className="text-lg">{portForwardingStatus.externalIP || 'Unknown'}</p>
            </div>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => loadNetworkStatus()}
            >
              Refresh
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {portForwardingStatus.requiredPorts.map(port => (
              <div key={port} className="p-4 border-2 border-[var(--color-secondary)]/20 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono">Port {port}</span>
                  <StatusIndicator 
                    status={getPortStatus(port) === 'open' ? 'active' : 'inactive'} 
                    size="sm" 
                  />
                </div>
                <p className="text-sm text-[var(--color-accent)]">
                  {getPortStatus(port) === 'open' ? 'Accessible' : 'Not accessible'}
                </p>
              </div>
            ))}
          </div>

          <div className="p-4 bg-[var(--color-secondary)]/5 rounded-xl">
            <h3 className="font-mono text-sm mb-2">Required Ports:</h3>
            <ul className="text-sm text-[var(--color-accent)] space-y-1">
              <li><strong>80</strong> - HTTP traffic</li>
              <li><strong>443</strong> - HTTPS traffic</li>
              <li><strong>8080</strong> - LibreServ dashboard</li>
            </ul>
          </div>
        </div>
      </Card>

      {/* Route Management */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-lg flex items-center gap-2">
            <Settings size={20} />
            Routes ({routes.length})
          </h2>
          <Button onClick={() => setShowAddRoute(true)}>
            <Plus size={16} />
            Add Route
          </Button>
        </div>
        
        {routes.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-[var(--color-accent)]">No routes configured</p>
            <p className="text-sm text-[var(--color-accent)] mt-1">
              Add your first route to start serving apps
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {routes.map(route => (
              <div key={route.id} className="p-4 border-2 border-[var(--color-secondary)]/20 rounded-xl">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-mono text-lg">
                        {route.subdomain}.{route.domain}
                      </span>
                      <StatusIndicator 
                        status={route.enabled ? 'active' : 'inactive'} 
                        size="sm" 
                      />
                      <Pill size="sm">{route.enabled ? 'Active' : 'Disabled'}</Pill>
                    </div>
                    <p className="text-sm text-[var(--color-accent)]">
                      Backend: {route.backend}
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => copyToClipboard(`https://${route.subdomain}.${route.domain}`)}
                    >
                      <Copy size={16} />
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => deleteRoute(route.id)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Add Route Modal */}
      <Modal 
        isOpen={showAddRoute} 
        onClose={() => setShowAddRoute(false)}
        title="Add New Route"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-mono mb-2">Subdomain</label>
            <Input
              placeholder="app"
              value={newRoute.subdomain}
              onChange={(e) => setNewRoute({...newRoute, subdomain: e.target.value})}
            />
            <p className="text-sm text-[var(--color-accent)] mt-1">
              Route will be: {newRoute.subdomain || 'app'}.{domainConfig.defaultDomain || 'yourdomain.com'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-mono mb-2">Backend URL</label>
            <Input
              placeholder="http://localhost:3000"
              value={newRoute.backend}
              onChange={(e) => setNewRoute({...newRoute, backend: e.target.value})}
            />
          </div>

          <div>
            <label className="block text-sm font-mono mb-2">App ID (optional)</label>
            <Input
              placeholder="my-app"
              value={newRoute.appId}
              onChange={(e) => setNewRoute({...newRoute, appId: e.target.value})}
            />
          </div>

          <div className="flex gap-3">
            <Button 
              variant="outline" 
              onClick={() => setShowAddRoute(false)}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button 
              onClick={addRoute}
              disabled={!newRoute.subdomain || !newRoute.backend}
              className="flex-1"
            >
              Add Route
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}