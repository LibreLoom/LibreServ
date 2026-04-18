import { useState, useEffect, useCallback } from "react";
import { Info, Heart, Activity, RefreshCw, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import CollapsibleSection from "../../common/CollapsibleSection";
import ValueDisplay from "../../common/ValueDisplay";
import StatusBadge from "../../common/StatusBadge";
import SettingsCard from "../SettingsCard";
import AnimatedCheckbox from "../../ui/AnimatedCheckbox";
import { useAuth } from "../../../hooks/useAuth";
import api from "../../../lib/api";

const APP_VERSION = "1.0.0";

const statusConfig = {
  passed: {
    icon: CheckCircle,
    color: "text-success",
    bg: "bg-success/10",
    borderColor: "border-success/20",
    label: "Passed",
  },
  failed: {
    icon: XCircle,
    color: "text-error",
    bg: "bg-error/10",
    borderColor: "border-error/20",
    label: "Failed",
  },
};

function HealthCheckRow({ name, result }) {
  const config = statusConfig[result.status] || statusConfig.failed;
  const StatusIcon = config.icon;
  
  return (
    <div className={`flex items-start justify-between py-3 px-4 border rounded-large-element ${config.bg} ${config.borderColor}`}>
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <StatusIcon size={16} className={config.color} />
          <span className="text-sm font-medium">{name}</span>
          <span className="text-xs px-2 py-0.5 rounded-pill bg-secondary/10">
            {result.category}
          </span>
        </div>
        <p className="text-xs ml-6">{result.message}</p>
        {result.details && typeof result.details === 'object' && (
          <div className="mt-2 ml-6 text-xs space-y-1">
            {Object.entries(result.details).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <span className="font-mono">{key}:</span>
                <span>{typeof value === 'number' && key.includes('bytes') ? formatBytes(value) : String(value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes) {
  if (!bytes) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

export default function AboutCategory({ settings }) {
  const { request } = useAuth();
  const [healthData, setHealthData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastChecked, setLastChecked] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState(null);

  const runHealthCheck = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = force ? '/system/health/check/refresh' : '/system/health/check';
      const method = force ? 'POST' : 'GET';
      const res = await request(endpoint, { method });
      
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error?.message || 'Health check failed');
      }
      
      const data = await res.json();
      setHealthData(data);
      setLastChecked(new Date().toISOString());
    } catch (error) {
      console.error('Health check failed:', error);
      setError(error.message);
      setHealthData(null);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    runHealthCheck();
    
    if (autoRefresh) {
      const interval = setInterval(() => {
        runHealthCheck();
      }, 30000);
      
      return () => clearInterval(interval);
    }
  }, [autoRefresh, runHealthCheck]);

  return (
    <div className="space-y-4">
      <SettingsCard icon={Info} title="Application" padding={false} index={0}>
        <div className="px-5 py-4 space-y-4">
          <ValueDisplay label="Version" value={APP_VERSION} />

          <CollapsibleSection title="Server Details" size="sm" pill defaultOpen mono>
            <div className="space-y-2">
              <ValueDisplay label="Backend API" value={settings?.server?.host} />
              <ValueDisplay label="Server Port" value={settings?.server?.port} />
              <ValueDisplay label="Proxy Type" value={settings?.proxy?.type || "None"} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Backend Info" mono size="sm" pill>
            <div className="space-y-2">
              <ValueDisplay label="Host" value={settings?.server?.host || "N/A"} />
              <ValueDisplay label="Port" value={settings?.server?.port || "N/A"} />
              <div className="flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5">
                <span className="text-sm text-accent">Mode</span>
                <StatusBadge variant={settings?.server?.mode === "production" ? "default" : "warning"}>
                  {settings?.server?.mode || "N/A"}
                </StatusBadge>
              </div>
            </div>
          </CollapsibleSection>

          {settings?.proxy && (
            <CollapsibleSection title="Proxy Info" mono size="sm" pill>
              <div className="space-y-2">
                <ValueDisplay label="Type" value={settings?.proxy?.type || "N/A"} />
                {settings?.proxy?.mode && (
                  <div className="flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5">
                    <span className="text-sm text-accent">Mode</span>
                    <StatusBadge variant={settings?.proxy?.mode === "production" ? "default" : "warning"}>
                      {settings?.proxy?.mode}
                    </StatusBadge>
                  </div>
                )}
                {settings?.proxy?.admin_api && (
                  <ValueDisplay label="Admin API" value={settings?.proxy?.admin_api} />
                )}
                {settings?.proxy?.default_domain && (
                  <ValueDisplay label="Default Domain" value={settings?.proxy?.default_domain} />
                )}
                <div className="flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5">
                  <span className="text-sm text-accent">Auto HTTPS</span>
                  <StatusBadge variant={settings?.proxy?.auto_https ? "default" : "accent"}>
                    {settings?.proxy?.auto_https ? "Enabled" : "Disabled"}
                  </StatusBadge>
                </div>
              </div>
            </CollapsibleSection>
          )}
        </div>
      </SettingsCard>

      <SettingsCard icon={Activity} title="System Health Check" padding={false} index={1}>
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-pill ${
                healthData?.overall_pass 
                  ? 'bg-success/10' 
                  : healthData 
                    ? 'bg-error/10' 
                    : 'bg-secondary/10'
              }`}>
                {healthData?.overall_pass ? (
                  <CheckCircle size={18} className="text-success" />
                ) : healthData ? (
                  <XCircle size={18} className="text-error" />
                ) : (
                  <Activity size={18} className="text-secondary" />
                )}
                <span className={`text-sm font-medium ${
                  healthData?.overall_pass 
                    ? 'text-success' 
                    : healthData 
                      ? 'text-error' 
                      : 'text-secondary'
                }`}>
                  {healthData?.overall_pass ? 'All Checks Passed' : healthData ? 'Some Checks Failed' : 'Not Checked'}
                </span>
              </div>
              {lastChecked && (
                <span className="px-3 py-1.5 rounded-full bg-gray-200 text-xs font-medium border border-gray-300">
                  Last checked: {new Date(lastChecked).toLocaleTimeString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center px-3 py-1.5 rounded-full bg-gray-200 border border-gray-300">
                <AnimatedCheckbox
                  checked={autoRefresh}
                  onChange={setAutoRefresh}
                >
                  Auto-refresh
                </AnimatedCheckbox>
              </div>
              <button
                onClick={() => runHealthCheck(true)}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-large-element bg-primary text-secondary hover:ring-2 hover:ring-accent transition-all disabled:opacity-50"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                {loading ? 'Checking...' : 'Run Checks'}
              </button>
            </div>
          </div>

          {error && (
            <div className="p-4 border border-error/20 rounded-large-element bg-error/10">
              <div className="flex items-start gap-3">
                <XCircle size={20} className="text-error flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-error mb-1">Health Check Failed</p>
                  <p className="text-sm">{error}</p>
                </div>
              </div>
            </div>
          )}

          {healthData && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 border border-primary/20 rounded-large-element bg-primary/5">
                  <div className="text-xs text-primary mb-1">Total Checks</div>
                  <div className="text-2xl font-bold">{healthData.summary.total_checks}</div>
                </div>
                <div className="p-3 border border-success/20 rounded-large-element bg-success/5">
                  <div className="text-xs text-success/80 mb-1">Passed</div>
                  <div className="text-2xl font-bold text-success">{healthData.summary.passed}</div>
                </div>
                <div className="p-3 border border-error/20 rounded-large-element bg-error/5">
                  <div className="text-xs text-error/80 mb-1">Failed</div>
                  <div className="text-2xl font-bold text-error">{healthData.summary.failed}</div>
                </div>
                <div className="p-3 border border-accent/20 rounded-large-element bg-accent/5">
                  <div className="text-xs text-primary mb-1">Disk Space</div>
                  <div className="text-lg font-bold">
                    {healthData.summary.system_health?.disk_free_human || 'N/A'}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {Object.entries(healthData.checks).map(([name, result]) => (
                  <HealthCheckRow key={name} name={name} result={result} />
                ))}
              </div>
            </>
          )}

          {!healthData && !loading && !error && (
            <div className="text-center py-8">
              <Activity size={48} className="mx-auto mb-3 opacity-50" />
              <p className="text-sm">Click "Run Checks" to perform a comprehensive system health check</p>
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard icon={Heart} title="LibreServ" padding={false} index={2}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            LibreServ is a self-hosted application management platform that
            allows you to easily deploy and manage self-hosted applications.
          </p>
          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-sm text-accent">
              <Heart size={14} className="text-error" />
              <span>Made with love for the open source community</span>
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
