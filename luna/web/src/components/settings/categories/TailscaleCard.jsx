import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import TailscaleSettings from "@libreloom/ui/components/settings/TailscaleCard.jsx";
import { apiErrorMessage, getJson, postJson } from "../../../lib/api.js";

const PATH = "/api/v1/tailscale";
const QUERY_KEY = ["tailscale-status"];
const MUTATION_KEY = ["tailscale-change"];

export default function TailscaleCard() {
  const { addToast } = useToast();
  const cache = useQueryClient();
  const changing = useIsMutating({ mutationKey: MUTATION_KEY }) > 0;
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => getJson(`${PATH}/status`, { signal }),
    enabled: !changing,
    refetchInterval: (query) => query.state.data?.state === "error" || query.state.status === "error" ? 60000 : 15000,
    retry: false,
  });
  const mutation = useMutation({
    mutationKey: MUTATION_KEY,
    onMutate: () => cache.cancelQueries({ queryKey: QUERY_KEY }),
    mutationFn: (/** @type {{ action: string, body?: object }} */ { action, body = {} }) => postJson(`${PATH}/${action}`, body),
    onSuccess: async (data, variables) => {
      await cache.cancelQueries({ queryKey: QUERY_KEY });
      cache.setQueryData(QUERY_KEY, data);
      addToast({
        type: data.residual_exposure || data.stop_serve_fallback ? "error" : "success",
        message:
          data.residual_exposure ? "Tailscale could not be stopped" : variables.action === "stop-serve" && data.stop_serve_fallback
            ? "Could not turn off web access. Tailscale was turned off instead."
            : data.auth_url || data.approval_url
            ? "Tailscale approval link ready"
            : "Tailscale settings updated",
      });
    },
    onSettled: () => cache.invalidateQueries({ queryKey: QUERY_KEY }),
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
