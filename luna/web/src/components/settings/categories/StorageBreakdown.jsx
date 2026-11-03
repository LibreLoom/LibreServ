import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { apiErrorMessage, getJson, postJson } from "../../../lib/api.js";
import { formatBytes } from "../../../lib/formatBytes.js";

const STORAGE_QUERY_KEY = ["system-storage"];

/**
 * What is using Luna's own disk, biggest first, with the one fix that exists:
 * clearing the temporary files Luna keeps while a document is being edited.
 *
 * @param {{ enabled?: boolean }} props
 */
export default function StorageBreakdown({ enabled = true }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const storage = useQuery({
    queryKey: STORAGE_QUERY_KEY,
    queryFn: () => getJson("/api/v1/system/storage"),
    enabled,
    retry: false,
  });

  const cleanup = useMutation({
    mutationFn: () => postJson("/api/v1/system/storage/cleanup", {}),
    onSuccess: (data) => {
      const freed = Number(data?.freed_bytes) || 0;
      addToast({
        type: "success",
        message: freed > 0 ? `Freed ${formatBytes(freed)}.` : "Nothing to clear right now.",
      });
      queryClient.invalidateQueries({ queryKey: STORAGE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["system-health-check"] });
    },
    onError: (err) => {
      addToast({
        type: "error",
        message: "Luna couldn't clear space.",
        description: apiErrorMessage(err),
      });
    },
  });

  if (storage.isLoading && !storage.data) {
    return (
      <div className="mt-3 space-y-2 animate-pulse" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-3 rounded-pill bg-primary/10" />
        ))}
      </div>
    );
  }

  if (!storage.data) {
    if (!storage.error) return null;
    return (
      <p className="mt-3 flex items-start gap-2 text-xs" role="alert">
        <TriangleAlert size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
        <span>Luna couldn&apos;t look at its own storage. Try again in a moment.</span>
      </p>
    );
  }

  const { items = [], free_bytes: free = 0, total_bytes: total = 0 } = storage.data;
  const removable = items.filter((item) => item.removable && item.bytes > 0);
  const canClear = removable.length > 0;

  return (
    <div className="mt-3" data-slot="storage-breakdown">
      <p className="text-xs text-primary">
        {formatBytes(free)} free of {formatBytes(total)} on Luna&apos;s own disk.{" "}
        <InfoHint content="Luna keeps its software, its settings, and the editors for documents and diagrams on this disk. Your files are on your drives." />
      </p>

      {items.length > 0 && (
        <ul className="mt-2 space-y-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 break-words">{item.label}</span>
              <span className="shrink-0 tabular-nums">{formatBytes(item.bytes)}</span>
            </li>
          ))}
        </ul>
      )}

      {canClear && (
        <div className="mt-3">
          <Button
            variant="outline"
            surface="secondary"
            size="sm"
            onClick={() => cleanup.mutate()}
            disabled={cleanup.isPending}
          >
            {cleanup.isPending ? "Clearing…" : "Free up space"}
          </Button>
          <p className="text-xs mt-1.5">
            Clears temporary copies of documents that aren&apos;t open. Nothing on your drives is
            touched.
          </p>
        </div>
      )}
    </div>
  );
}
