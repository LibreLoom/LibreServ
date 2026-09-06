import { Wrench, Play, AlertTriangle } from "lucide-react";
import Button from "../../ui/Button";
import { cn } from "@/lib/utils";
import { ICON_SIZE } from "@/lib/ui-tokens";

/** @param {{ action: any, onExecute: any, disabled?: any, loading?: any }} _ */
export function ActionCard({ action, onExecute, disabled, loading }) {
  const hasOptions = action.options?.length > 0;
  const isConfirm = action.confirm?.enabled;

  return (
    <div
      className={cn(
        "flex items-center justify-between p-4 rounded-large-element motion-safe:transition-colors",
        isConfirm
          ? "border border-warning/30 bg-warning/10 hover:border-warning/50"
          : "border border-secondary/20 hover:border-secondary/40",
      )}
      data-slot="action-card"
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "p-2 rounded-full",
            isConfirm ? "bg-warning/15" : "bg-secondary/10",
          )}
        >
          {isConfirm ? (
            <AlertTriangle className="text-warning" size={ICON_SIZE.xl} />
          ) : (
            <Wrench className="text-accent" size={ICON_SIZE.xl} />
          )}
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
        variant={isConfirm ? "secondary" : "secondary"}
        surface="primary"
        onClick={() => onExecute(action)}
        disabled={disabled || loading}
        loading={loading}
      >
        {loading ? (
          "Running..."
        ) : (
          <>
            <Play size={ICON_SIZE.md} />
            Run
          </>
        )}
      </Button>
    </div>
  );
}
