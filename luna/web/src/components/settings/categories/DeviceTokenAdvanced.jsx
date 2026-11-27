import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { apiErrorMessage, getJson, putJson } from "../../../lib/api";
import { isValidDeviceToken, normalizeDeviceToken } from "../../../lib/deviceIdentity.js";
import { useOptionalAuth } from "../../../context/AuthContext";

/** The device token inside Settings → About → Advanced: its state for everyone, set and replace for Admins. */
export default function DeviceTokenAdvanced({ className = "" }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const isAdmin = useOptionalAuth()?.user?.role === "admin";
  const [open, setOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState(null);

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
    onError: (err) => setError(apiErrorMessage(err, "Couldn't save the device token. Try again.")),
  });

  const tokenSet = Boolean(status.data?.device_token_set);

  return (
    <>
      <CollapsibleSection title="Device token" mono pill className={className}>
        {status.isError ? (
          <PageNotice variant="error" className="mb-3">
            Luna couldn&apos;t load the device token. Try again.
          </PageNotice>
        ) : null}
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
            hideDivider
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
      </CollapsibleSection>

      <ModalCard
        open={open}
        title={tokenSet ? "Replace device token" : "Set device token"}
        onClose={() => setOpen(false)}
      >
        <div className="space-y-4">
          <p className="text-sm text-primary">
            Enter the 20-character device token for this Luna. It is saved on Luna only.
          </p>
          <div className="space-y-1">
            <label className="block text-sm text-primary translate-x-5" htmlFor="device-token-input">
              Device token
            </label>
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
