import { Cloud } from "lucide-react";
import Card from "../cards/Card";
import CloudBackupConfig from "./CloudBackupConfig";

export default function CloudBackupCard({
  showConfig,
  onToggleConfig,
  onConfigured,
}) {
  return (
    <Card
      icon={Cloud}
      title="Cloud Backup"
      padding={false}
      headerActions={
        <button
          onClick={onToggleConfig}
          className="text-xs text-accent hover:text-primary transition-colors"
        >
          {showConfig ? "Hide" : "Configure"}
        </button>
      }
      className="animate-in fade-in slide-in-from-bottom-2"
    >
      <div
        className={`overflow-hidden transition-all ease-[var(--motion-easing-emphasized)] ${
          showConfig ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
        }`}
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div className="p-4">
          <CloudBackupConfig onConfigured={onConfigured} />
        </div>
      </div>
      {!showConfig && (
        <div
          className="animate-in fade-in slide-in-from-bottom-2 px-4 py-6 text-center"
          style={{ animationDuration: "var(--motion-duration-medium2)" }}
        >
          <Cloud className="w-8 h-8 text-primary/30 mx-auto mb-2" />
          <p className="text-sm text-accent">
            Configure cloud backup for off-site storage
          </p>
          <button
            onClick={onToggleConfig}
            className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm"
          >
            Configure Cloud Backup
          </button>
        </div>
      )}
    </Card>
  );
}
