import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import TailscaleSettings from "@libreloom/ui/components/settings/TailscaleCard.jsx";
import { apiErrorMessage, getJson, postJson } from "../../../lib/api.js";

const PATH = "/api/v1/tailscale";

export default function TailscaleCard() {
  const { addToast } = useToast();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["tailscale-status"],
    queryFn: () => getJson(`${PATH}/status`),
    refetchInterval: (query) => query.state.data?.state === "error" || query.state.status === "error" ? 60000 : 15000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (/** @type {{ action: string, body?: object }} */ { action, body = {} }) => postJson(`${PATH}/${action}`, body),
    onSuccess: (data) => {
      cache.setQueryData(["tailscale-status"], data);
      addToast({
        type: data.residual_exposure ? "error" : "success",
        message:
          data.residual_exposure ? "Tailscale could not be stopped" : data.auth_url || data.approval_url
            ? "Tailscale approval link ready"
            : "Tailscale settings updated",
      });
    },
  });
  const error = mutation.error || query.error;
  return (
    <TailscaleSettings
      product="Luna"
      status={query.data}
      loading={query.isPending}
      busy={mutation.isPending}
      error={
        error
          ? apiErrorMessage(
              error,
              "Luna could not update Tailscale. Try again.",
            )
          : ""
      }
      onAction={(action, body = {}) => mutation.mutate({ action, body })}
    />
  );
}
