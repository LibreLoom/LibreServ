import { Wrench, Play } from "lucide-react";
import Button from "../../ui/Button";

/** @param {{ action: any, onExecute: any, disabled?: any, loading?: any }} _ */
export function ActionCard({ action, onExecute, disabled, loading }) {
  const hasOptions = action.options?.length > 0;

  return (
    <div className="flex items-center justify-between p-4 border border-secondary/20 rounded-large-element hover:border-secondary/40 motion-safe:transition-colors" data-slot="action-card">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-secondary/10 rounded-full">
          <Wrench className="text-accent" size={20} />
        </div>
        <div>
          <p className="font-mono font-medium">{action.label}</p>
          {hasOptions && (
            <span className="inline-block text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-pill mt-1">
              Has options
            </span>
          )}
        </div>
      </div>
      <Button
        variant="secondary"
        surface="primary"
        onClick={() => onExecute(action)}
        disabled={disabled || loading}
        loading={loading}
      >
        {loading ? (
          "Running..."
        ) : (
          <>
            <Play size={16} />
            Run
          </>
        )}
      </Button>
    </div>
  );
}
