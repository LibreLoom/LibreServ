import { AlertTriangle, Loader2 } from "lucide-react";
import ModalCard from "../../cards/ModalCard";

export function ActionConfirmModal({ action, onConfirm, onCancel, isConfirming }) {
  return (
    <ModalCard title={`Confirm: ${action.label}`} onClose={onCancel}>
      <div className="space-y-4">
        {action.confirm?.message && (
          <div className="flex items-start gap-3 p-3 bg-accent/10 rounded-large-element border border-accent/30">
            <AlertTriangle className="text-accent shrink-0 mt-0.5" size={20} />
            <p className="text-sm">{action.confirm.message}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={isConfirming}
            className="flex-1 px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50 font-mono"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isConfirming}
            className="flex-1 px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/80 motion-safe:transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-mono"
          >
            {isConfirming ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Confirming...
              </>
            ) : (
              "Confirm"
            )}
          </button>
        </div>
      </div>
    </ModalCard>
  );
}
