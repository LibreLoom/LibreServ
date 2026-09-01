import { FileCode, RefreshCw } from "lucide-react";
import Card from "../cards/Card";
import CollapsibleSection from "../common/CollapsibleSection";
import Button from "../ui/Button";

export default function DebugCard({ content, onReload }) {
  const isEmpty = !content || content.trim().length === 0;

  return (
    <Card
      data-slot="network-debug"
      icon={FileCode}
      title="Configuration"
      padding={false}
    >
      <div className="px-4 py-3">
        <CollapsibleSection title="Configuration File" pill={true}>
          <div className="bg-primary/5 rounded-card p-3">
            <div className="flex items-start justify-between gap-3 mb-3">
              <p className="text-xs text-accent">
                This shows the technical configuration file that controls your proxy. You usually don't need to look at this.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={onReload}
                tooltip="Reload configuration"
                className="shrink-0"
              >
                <RefreshCw size={14} aria-hidden="true" />
                Reload
              </Button>
            </div>
            {isEmpty ? (
              <p className="text-sm text-accent italic">
                No configuration generated yet
              </p>
            ) : (
              <pre className="text-xs font-mono text-accent overflow-x-auto whitespace-pre-wrap">
                {content}
              </pre>
            )}
          </div>
        </CollapsibleSection>
      </div>
    </Card>
  );
}