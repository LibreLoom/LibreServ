import { useState, useEffect } from "react";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import Card from "../cards/Card";
import {
  Cloud,
  Server,
  Check,
  X,
  Loader2,
  Eye,
  EyeOff,
  AlertCircle,
  Folder,
  Copy,
} from "lucide-react";

const PROVIDERS = [
  { id: "backblaze", name: "Backblaze B2", icon: "backblaze" },
  { id: "s3", name: "S3-Compatible Storage", icon: "s3" },
  { id: "manual", name: "Manual Setup", icon: "manual" },
];

const PROVIDER_SETUP_GUIDES = {
  backblaze: `1. Sign up at backblaze.com
2. Create a B2 bucket in your dashboard
3. Create an application key with read/write access
4. Enter your Key ID and Key Secret below`,

  s3: `1. Create an S3 bucket (or use any S3-compatible storage)
2. Create an IAM user with read/write permissions
3. Enter your Access Key ID and Secret Access Key below
4. For non-AWS storage, provide the custom endpoint`,
};

function ProviderIcon({ provider, className = "w-6 h-6" }) {
  switch (provider) {
    case "backblaze":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
        </svg>
      );
    case "s3":
      return <Server className={className} />;
    case "manual":
      return <Folder className={className} />;
    default:
      return <Cloud className={className} />;
  }
}

export default function CloudBackupConfig({ onConfigured }) {
  const { request } = useAuth();
  const { addToast } = useToast();

  const [selectedProvider, setSelectedProvider] = useState("backblaze");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [showSecret, setShowSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [backupPath, setBackupPath] = useState("./dev/apps/backups");

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    try {
      const configRes = await request("/backups/cloud/config");

      if (!configRes.ok) {
        const err = await configRes.json();
        throw new Error(err.error || "Failed to load configuration");
      }

      const configData = await configRes.json();

      if (configData.configured && configData.config) {
        setSelectedProvider(configData.config.provider);
        setBucket(configData.config.bucket || "");
        setRegion(configData.config.region || "");
        setKeyId(configData.config.key_id || "");
        setEndpoint(configData.config.endpoint || "");
        setEnabled(configData.config.enabled !== false);
      }

      // Try to get actual backup path from settings
      try {
        const settingsRes = await request("/settings");
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          if (settings.backup_path) {
            setBackupPath(settings.backup_path);
          }
        }
      } catch {
        // Use default path
      }
    } catch (err) {
      console.error("Failed to load cloud backup config:", err);
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);

    try {
      await saveConfig(false);

      const res = await request("/backups/cloud/test", {
        method: "POST",
      });

      const result = await res.json();
      setTestResult(result);

      if (result.success) {
        addToast({ type: "success", message: "Connection successful", description: "Your cloud storage is properly configured." });
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: "Connection test failed",
        error: err.message,
      });
      addToast({ type: "error", message: "Connection failed", description: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function saveConfig(enableAfterSave = enabled) {
    const payload = {
      provider: selectedProvider,
      bucket: bucket,
      region: selectedProvider === "s3" ? region : "",
      key_id: keyId,
      key_secret: keySecret,
      endpoint: selectedProvider === "s3" ? endpoint : "",
      enabled: enableAfterSave,
    };

    const res = await request("/backups/cloud/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to save configuration");
    }

    return res.json();
  }

  async function handleSave() {
    setSaving(true);

    try {
      await saveConfig(enabled);
      addToast({ type: "success", message: "Configuration saved", description: "Your cloud backup settings have been saved." });

      if (onConfigured) {
        onConfigured();
      }
    } catch (err) {
      console.error("Failed to save config:", err);
      addToast({ type: "error", message: "Failed to save", description: err.message });
    } finally {
      setSaving(false);
    }
  }

  function handleProviderChange(providerId) {
    setSelectedProvider(providerId);
    setTestResult(null);
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text);
    addToast({ type: "success", message: "Copied to clipboard" });
  }

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="p-6">
          <div className="text-center">
            <AlertCircle className="w-10 h-10 text-error mx-auto mb-2" />
            <p className="font-mono text-sm text-error mb-3">{loadError}</p>
          <button
            onClick={loadData}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm"
          >
            Retry
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <h2 className="font-mono text-lg text-primary mb-4">
          Cloud Backup Configuration
        </h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-mono text-primary/70 mb-2">
              Provider
            </label>
            <div className="grid grid-cols-3 gap-3">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleProviderChange(p.id)}
                  className={`flex items-center gap-2 p-3 rounded-pill border transition-all ${
                    selectedProvider === p.id
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-secondary/30 hover:border-secondary"
                  }`}
                >
                  <ProviderIcon provider={p.id} className="w-5 h-5" />
                  <span className="font-mono text-sm">{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          {selectedProvider === "manual" ? (
            <div className="space-y-4">
              <div className="bg-secondary/5 rounded-card p-4">
                <h3 className="font-mono text-sm text-primary mb-3">Manual Backup Instructions</h3>
                <p className="font-mono text-sm text-primary/70 mb-4">
                  Your backups are stored in the directory below. You can use any sync tool 
                  (rclone, rsync, etc.) to copy them to your preferred cloud storage.
                </p>

                <div className="bg-primary/5 rounded-card p-3 mb-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-mono text-xs text-primary/50 mb-1">Backup Location</p>
                      <p className="font-mono text-sm text-primary font-semibold">{backupPath}</p>
                    </div>
                    <button
                      onClick={() => copyToClipboard(backupPath)}
                      className="p-2 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                      title="Copy path"
                    >
                      <Copy size={16} />
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  <p className="font-mono text-sm text-primary">Example commands:</p>
                    <div className="bg-primary/5 rounded-card p-3 font-mono text-xs text-primary/70">
                    <p className="mb-2"># Using rclone:</p>
                    <p className="text-primary">rclone sync {backupPath} remote:libreserv-backups/</p>
                  </div>
                    <div className="bg-primary/5 rounded-card p-3 font-mono text-xs text-primary/70">
                    <p className="mb-2"># Using rsync:</p>
                    <p className="text-primary">rsync -avz {backupPath}/ user@server:/backup/libreserv/</p>
                  </div>
                </div>
              </div>

              <div className="bg-warning/10 border border-warning/30 rounded-card p-3">
                <p className="font-mono text-xs text-warning">
                  Note: Manual mode does not upload backups automatically. You are responsible for 
                  setting up and maintaining your own backup sync solution.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="bg-secondary/5 rounded-card p-4">
                <p className="font-mono text-sm text-primary/70 whitespace-pre-line">
                  {PROVIDER_SETUP_GUIDES[selectedProvider]}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">
                    Bucket Name *
                  </label>
                   <input
                     type="text"
                     value={bucket}
                     onChange={(e) => setBucket(e.target.value)}
                     className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                     placeholder="my-backup-bucket"
                   />
                </div>

                {selectedProvider === "s3" && (
                  <div>
                    <label className="block text-sm font-mono text-primary/70 mb-2">
                      Region
                    </label>
                       <input
                         type="text"
                         value={region}
                         onChange={(e) => setRegion(e.target.value)}
                         className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                         placeholder="us-east-1"
                       />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">
                    {selectedProvider === "s3" ? "Access Key ID *" : "Key ID *"}
                  </label>
                   <input
                     type="text"
                     value={keyId}
                     onChange={(e) => setKeyId(e.target.value)}
                     className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                     placeholder="Enter your key ID"
                   />
                </div>

                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">
                    {selectedProvider === "s3" ? "Secret Access Key *" : "Key Secret *"}
                  </label>
                  <div className="relative">
                     <input
                       type={showSecret ? "text" : "password"}
                       value={keySecret}
                       onChange={(e) => setKeySecret(e.target.value)}
                       className="w-full px-3 py-2 pr-10 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                       placeholder="Enter your secret"
                     />
                    <button
                      type="button"
                      onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-primary/50 hover:text-primary"
                    >
                      {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              </div>

              {selectedProvider === "s3" && (
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">
                    Custom Endpoint (optional)
                  </label>
                   <input
                     type="text"
                     value={endpoint}
                     onChange={(e) => setEndpoint(e.target.value)}
                     className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                     placeholder="https://s3.example.com"
                   />
                  <p className="mt-1 text-xs text-primary/50 font-mono">
                    For non-AWS S3-compatible storage (MinIO, Wasabi, etc.)
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="cloud-enabled"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="w-4 h-4 rounded accent-accent"
                />
                <label htmlFor="cloud-enabled" className="font-mono text-sm text-primary">
                  Upload backups to cloud automatically after creation
                </label>
              </div>
            </>
          )}
        </div>
      </Card>

      {testResult && !testResult.success && (
        <div className="p-4 rounded-card bg-error/10 border border-error/30">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-error mt-0.5" />
            <div className="flex-1">
              <p className="font-mono text-sm text-error">
                {testResult.message}
              </p>
              {testResult.error && (
                <p className="font-mono text-xs text-error/70 mt-1">
                  {testResult.error}
                </p>
              )}
            </div>
            <button
              onClick={() => setTestResult(null)}
              className="text-error/50 hover:text-error"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {selectedProvider !== "manual" && (
        <div className="flex gap-3">
          <button
            onClick={handleTestConnection}
            disabled={testing || !bucket || !keyId || !keySecret}
            className="flex items-center gap-2 px-4 py-2 rounded-pill bg-secondary/10 text-primary hover:bg-secondary/20 transition-all font-mono text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Server className="w-4 h-4" />
            )}
            Test Connection
          </button>

          <button
            onClick={handleSave}
            disabled={saving || !bucket || !keyId || !keySecret}
             className="flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-accent hover:ring-2 transition-all font-mono text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            Save Configuration
          </button>
        </div>
      )}
    </div>
  );
}
