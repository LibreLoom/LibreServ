import { FileCode, RefreshCw } from "lucide-react";
import Card from "../cards/Card";
import CollapsibleSection from "../common/CollapsibleSection";

export default function DebugCard({ content, onReload }) {
  const isEmpty = !content || content.trim().length === 0;

  return (
    <Card
      icon={FileCode}
      title="Advanced"
      padding={false}
      headerActions={
        <button
          onClick={onReload}
          className="flex items-center gap-1 text-xs text-accent hover:text-primary transition-colors"
          title="Reload configuration"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Reload
        </button>
      }
    >
      <div className="px-4 py-3">
        <CollapsibleSection
          title="Configuration File"
          defaultOpen={false}
          pill={true}
        >
          <div className="bg-primary/5 rounded-card p-3">
            <p className="text-xs text-accent mb-3">
              This file is generated automatically by LibreServ.
            </p>
            {isEmpty ? (
              <p className="text-sm text-primary/50 italic">
                No configuration generated yet
              </p>
            ) : (
              <pre className="text-xs font-mono text-primary/80 overflow-x-auto whitespace-pre-wrap">
                {content}
              </pre>
            )}
          </div>
        </CollapsibleSection>
      </div>
    </Card>
  );
}