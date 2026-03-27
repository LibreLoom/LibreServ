import { Wrench, Play, Loader2 } from "lucide-react";

export function ActionCard({ action, onExecute, disabled, loading }) {
  const hasOptions = action.options?.length > 0;

  return (
    <div className="flex items-center justify-between p-4 border border-secondary/20 rounded-large-element hover:border-secondary/40 motion-safe:transition-colors">
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
      <button
        onClick={() => onExecute(action)}
        disabled={disabled || loading}
        className="flex items-center gap-2 px-4 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed motion-safe:transition-all font-mono"
      >
        {loading ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Running...
          </>
        ) : (
          <>
            <Play size={16} />
            Run
          </>
        )}
      </button>
    </div>
  );
}
