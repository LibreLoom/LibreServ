import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { apiErrorMessage, deleteJson, getJson, putJson } from "../../../lib/api";
import { connectState } from "../../../lib/connectState.js";
import { isValidDeviceToken, normalizeDeviceToken } from "../../../lib/deviceIdentity.js";
import { useOptionalAuth } from "../../../context/AuthContext";

const LUNA_CONNECT_URL = "https://connect.luna.libreloom.org";

/** The device token problem to show, from the Connect status: a refused token, a pending disconnect, or a revoked Luna. */
function tokenProblem(status) {
  if (!status) return "";
  if (status.connect_error) return status.connect_error;
  const state = connectState(status);
  if (status.unbind_pending || state === "pending") {
    return "Remote access and pairing are off until Luna finishes disconnecting.";
  }
  if (state === "revoked") return "Luna Connect revoked this Luna. Reconnect it from your Connect account.";
  return "";
}

/** The device token inside Settings → About → Advanced: its state for everyone, set and replace for Admins. */
export default function DeviceTokenAdvanced({ className = "" }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const isAdmin = useOptionalAuth()?.user?.role === "admin";
  const [open, setOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState(null);

  const status = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status", { cache: "no-store" }),
    retry: false,
  });

  const saveToken = useMutation({
    mutationFn: () => putJson("/api/v1/connect/device-token", {
      device_token: normalizeDeviceToken(tokenInput),
    }),
    onSuccess: () => {
      addToast({ type: "success", message: "Device token saved." });
      setOpen(false);
      setError(null);
      setTokenInput("");
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't save the device token. Try again."));
    },
  });

  const removeToken = useMutation({
    mutationFn: () => deleteJson("/api/v1/connect/device-token"),
    onSuccess: () => {
      addToast({ type: "success", message: "Device token removed." });
      setRemoveOpen(false);
      setRemoveError(null);
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err) => setRemoveError(apiErrorMessage(err, "Couldn't remove the device token. Try again.")),
  });

  const tokenSet = Boolean(status.data?.device_token_set);
  const problem = tokenProblem(status.data);

  return (
    <>
      <CollapsibleSection title="Device token" mono pill className={className}>
        {status.isError ? (
          <PageNotice variant="error" className="mb-3">
            Luna couldn&apos;t load the device token. Try again.
          </PageNotice>
        ) : null}
        {problem ? <PageNotice variant="error" className="mb-3">{problem}</PageNotice> : null}
        <SettingsRow
          label="Device token"
          description="Identifies this Luna to Luna Connect. It stays on Luna after a reset."
          hideDivider={!isAdmin}
        >
          <InlinePill>{tokenSet ? "Set" : "Not set"}</InlinePill>
        </SettingsRow>
        {isAdmin ? (
          <SettingsRow
            label={tokenSet ? "Replace device token" : "Set device token"}
            description="Saved on Luna only. Connect and remote access do not change."
            hideDivider={!(isAdmin && tokenSet)}
          >
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                saveToken.reset();
                setTokenInput("");
                setOpen(true);
              }}
            >
              {tokenSet ? "Replace token" : "Set token"}
            </Button>
          </SettingsRow>
        ) : null}
        {isAdmin && tokenSet ? (
          <SettingsRow
            label="Remove device token"
            description="To turn off Luna Connect on an unconnected Luna, remove the saved token."
            hideDivider
          >
            <Button
              variant="danger"
              onClick={() => {
                setRemoveError(null);
                removeToken.reset();
                setRemoveOpen(true);
              }}
            >
              Remove device token
            </Button>
          </SettingsRow>
        ) : null}
      </CollapsibleSection>

      <ConfirmModal
        open={removeOpen}
        variant="danger"
        icon={TriangleAlert}
        title="Remove device token?"
        message="Luna stops contacting Luna Connect until you set a device token again. Your files are not affected."
        confirmLabel="Remove device token"
        loading={removeToken.isPending}
        error={removeError}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => removeToken.mutate()}
      />

      <ModalCard
        open={open}
        title={tokenSet ? "Replace device token" : "Set device token"}
        onClose={() => setOpen(false)}
      >
        <div className="space-y-4">
          {problem ? <PageNotice variant="error">{problem}</PageNotice> : null}
          <p className="text-sm text-primary">
            Your device token is printed in the quick-start guide that came with your Luna, or shown when it was created in{" "}
            <a
              href={LUNA_CONNECT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-accent underline-offset-4 hover:decoration-current motion-safe:transition-colors"
            >
              Luna Connect
            </a>
            .
          </p>
          <div className="space-y-1">
            <label className="block text-sm text-primary translate-x-5" htmlFor="device-token-input">
              Device token
            </label>
            <ShakeTarget shake={error}>
              <input
                id="device-token-input"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="w-full rounded-pill surface-primary px-4 py-2 font-mono"
                value={tokenInput}
                onChange={(e) => {
                  setTokenInput(e.target.value.toUpperCase());
                  setError(null);
                }}
                placeholder="7K4M-2Q9X-R8N3-6T5W-1PZH"
                aria-invalid={Boolean(tokenInput.trim() && !isValidDeviceToken(tokenInput))}
              />
            </ShakeTarget>
          </div>
          {error ? <PageNotice variant="error">{error}</PageNotice> : null}
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              loading={saveToken.isPending}
              disabled={!isValidDeviceToken(tokenInput)}
              onClick={() => saveToken.mutate()}
            >
              Save token
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saveToken.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      </ModalCard>
    </>
  );
}

DeviceTokenAdvanced.propTypes = { className: PropTypes.string };
