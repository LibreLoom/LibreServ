import { AlertTriangle } from "lucide-react";
import ModalCard from "../../cards/ModalCard";
import Button from "../../ui/Button";
import { ICON_SIZE } from "@/lib/ui-tokens";

export function ActionConfirmModal({ action, onConfirm, onCancel, isConfirming }) {
  return (
    <ModalCard title={`Confirm: ${action.label}`} onClose={onCancel} data-slot="action-confirm-modal">
      {({ close }) => (
      <div className="space-y-4">
        {action.confirm?.message && (
          <div className="flex items-start gap-3 p-3 bg-accent/10 rounded-large-element border border-accent/30">
            <AlertTriangle className="text-accent shrink-0 mt-0.5" size={ICON_SIZE.xl} />
            <p className="text-sm">{action.confirm.message}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            surface="secondary"
            onClick={close}
            disabled={isConfirming}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            variant="accent"
            onClick={onConfirm}
            disabled={isConfirming}
            loading={isConfirming}
            className="flex-1"
          >
            {isConfirming ? "Confirming..." : "Confirm"}
          </Button>
        </div>
      </div>
      )}
    </ModalCard>
  );
}
