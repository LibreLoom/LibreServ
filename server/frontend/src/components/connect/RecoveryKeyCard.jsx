import { useState } from "react";
import { Key, Copy, Download, Eye, EyeOff, AlertTriangle } from "lucide-react";
import Card from "../cards/Card.jsx";

export default function RecoveryKeyCard({ repo }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!repo?.password) return;
    navigator.clipboard.writeText(repo.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownload = () => {
    if (!repo?.password) return;
    const content = [
      "# LibreServ Recovery Key",
      `# Repository: ${repo.repo_type}://${repo.repo_path}`,
      `# Saved: ${new Date().toLocaleString()}`,
      "# KEEP THIS FILE SAFE. Without it, you cannot restore your backups.",
      "",
      `RECOVERY_KEY=${repo.password}`,
      `REPO_TYPE=${repo.repo_type}`,
      `REPO_PATH=${repo.repo_path}`,
    ].join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `libreserv-recovery-key-${repo.id || "backup"}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card icon={Key} title="Backup Recovery Key" noHeightAnim
      headerActions={
        <span className="text-xs px-2.5 py-1 rounded-pill bg-primary border-2 border-warning/30 text-warning font-medium flex items-center gap-1">
          <AlertTriangle size={12} />
          Critical
        </span>
      }
    >
      <div className="p-5 space-y-4">
        <p className="text-sm text-accent">
          Your backups are encrypted with a key only this server knows. If you lose access
          to this server, you will need this key to restore your data. Save it somewhere safe —
          <strong className="text-primary"> we cannot recover it for you</strong>.
        </p>

        <div className="bg-primary/5 rounded-large-element p-4 space-y-3">
          <p className="text-xs text-accent font-mono">
            {repo?.repo_type} → {repo?.repo_path}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-primary rounded-pill px-4 py-2.5 text-secondary overflow-hidden text-ellipsis whitespace-nowrap border-2 border-secondary/10">
              {revealed ? repo?.password : "••••••••••••••••••••••••••"}
            </code>
            <button
              onClick={() => setRevealed(!revealed)}
              className="p-2.5 rounded-pill bg-primary hover:bg-primary/80 border-2 border-secondary/10 text-accent hover:text-secondary motion-safe:transition-colors"
              title={revealed ? "Hide key" : "Show key"}
            >
              {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button
              onClick={handleCopy}
              className="p-2.5 rounded-pill bg-primary hover:bg-primary/80 border-2 border-secondary/10 text-accent hover:text-secondary motion-safe:transition-colors"
              title={copied ? "Copied!" : "Copy to clipboard"}
            >
              <Copy size={16} />
            </button>
            <button
              onClick={handleDownload}
              className="p-2.5 rounded-pill bg-primary hover:bg-primary/80 border-2 border-secondary/10 text-accent hover:text-secondary motion-safe:transition-colors"
              title="Download key file"
            >
              <Download size={16} />
            </button>
          </div>
          {copied && (
            <p className="text-xs text-accent">Copied to clipboard.</p>
          )}
        </div>

        <div className="bg-primary border-2 border-warning/20 rounded-large-element p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" />
          <div className="text-xs text-accent space-y-1">
            <p className="font-medium text-secondary">Without this key:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Your backup data is permanently unrecoverable</li>
              <li>Even LibreServ Connect staff cannot decrypt your backups</li>
              <li>Store this key in a password manager or offline safe</li>
            </ul>
          </div>
        </div>
      </div>
    </Card>
  );
}
