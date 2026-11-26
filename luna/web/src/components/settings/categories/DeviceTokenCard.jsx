import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, TriangleAlert } from "lucide-react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { apiErrorMessage, getJson, postJson, putJson } from "../../../lib/api";
import { connectState } from "../../../lib/connectState.js";
import { isValidDeviceToken, normalizeDeviceToken } from "../../../lib/deviceIdentity.js";
import { useOptionalAuth } from "../../../context/AuthContext";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

const LUNA_CONNECT_URL = "https://connect.luna.libreloom.org";

const STATE_LABELS = {
  loading: "Loading",
  unbound: "Not paired",
  pairing: "Pairing",
  bound: "Paired",
  pending: "Disconnect pending",
  revoked: "Reconnect required",
};

const STATE_VARIANTS = {
  loading: "muted",
  unbound: "muted",
  pairing: "info",
  bound: "success",
  pending: "warning",
  revoked: "error",
};

/** The one device token Luna Connect uses to pair this Luna, plus Admin-only set, replace and disconnect. */
export default function DeviceTokenCard({ index = 0 }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const isAdmin = useOptionalAuth()?.user?.role === "admin";
  const [setOpen, setSetOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [setError, setSetError] = useState(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState(null);
  const [password, setPassword] = useState("");
  const passwordRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  const status = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status", { cache: "no-store" }),
    retry: false,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["connect-status"] });
    queryClient.invalidateQueries({ queryKey: ["auth-status"] });
  };

  const saveToken = useMutation({
    mutationFn: () => putJson("/api/v1/connect/device-token", {
      device_token: normalizeDeviceToken(tokenInput),
    }),
    onSuccess: () => {
      addToast({ type: "success", message: "Device token saved." });
      setSetOpen(false);
      setSetError(null);
      setTokenInput("");
      invalidate();
    },
    onError: (err) => setSetError(apiErrorMessage(err, "Couldn't save the device token. Try again.")),
  });

  const disconnect = useMutation({
    mutationFn: () => postJson("/api/v1/connect/unbind", { password }),
    onSuccess: () => {
      addToast({ type: "success", message: "Luna disconnected." });
      setDisconnectOpen(false);
      setDisconnectError(null);
      setPassword("");
      invalidate();
    },
    onError: (err) => setDisconnectError(apiErrorMessage(err, "Couldn't disconnect Luna Connect. Try again.")),
    onSettled: invalidate,
  });

  const s = status.data || {};
  const state = connectState(status.data);
  const tokenSet = Boolean(s.device_token_set);
  const canDisconnect = state === "bound" || state === "pending";
  const detailError = s.connect_error && state !== "pending" && state !== "revoked"
    ? s.connect_error
    : "";

  return (
    <>
      <SettingsCard
        icon={KeyRound}
        title="Device token"
        index={index}
        headerActions={<Pill variant={STATE_VARIANTS[state]}>{STATE_LABELS[state]}</Pill>}
        padding={false}
      >
        <div className="px-4 py-2">
          {status.isError ? (
            <PageNotice variant="error" className="mb-3">
              Luna couldn&apos;t load the Device token. Try again.
            </PageNotice>
          ) : null}

          {detailError ? (
            <PageNotice variant="error" className="mb-3">{detailError}</PageNotice>
          ) : null}
          {state === "pending" ? (
            <PageNotice variant="warning" className="mb-3">
              Remote access and pairing are off until Luna finishes disconnecting. Cloud backup stays off until then.
            </PageNotice>
          ) : null}
          {state === "revoked" ? (
            <PageNotice variant="error" className="mb-3">
              Luna Connect revoked this Luna. Reconnect it from Devices in your Connect account before pairing again.
            </PageNotice>
          ) : null}

          <SettingsRow
            label="Device token"
            description="Identifies this Luna to Luna Connect. It stays on Luna after a reset."
            hideDivider={state !== "unbound"}
          >
            <InlinePill>{tokenSet ? "Set" : "Not set"}</InlinePill>
          </SettingsRow>

          {state === "unbound" ? (
            <SettingsRow
              label="Pair this Luna"
              description={!isAdmin
                ? "An Admin can pair this Luna from Luna Connect."
                : tokenSet
                  ? "Enter the device token in your Luna Connect account."
                  : "Set the device token in Advanced first."}
              hideDivider
            >
              {isAdmin && tokenSet ? (
                <Button variant="outline" asChild>
                  <a href={LUNA_CONNECT_URL} target="_blank" rel="noopener noreferrer">
                    Open Luna Connect
                    <ChevronRight size={ICON_SIZE.md} aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </SettingsRow>
          ) : null}

          {isAdmin ? (
            <CollapsibleSection title="Advanced" mono pill className="my-2">
              <SettingsRow
                label={tokenSet ? "Replace device token" : "Set device token"}
                description="Saved on Luna only. Connect and remote access do not change."
                hideDivider
              >
                <Button
                  variant="outline"
                  onClick={() => {
                    setSetError(null);
                    saveToken.reset();
                    setTokenInput("");
                    setSetOpen(true);
                  }}
                >
                  {tokenSet ? "Replace token" : "Set token"}
                </Button>
              </SettingsRow>
            </CollapsibleSection>
          ) : null}

          {isAdmin && canDisconnect ? (
            <SettingsRow
              label="Disconnect"
              description="Remote access stops. You can connect this Luna again later."
              hideDivider
            >
              <Button
                variant="danger"
                onClick={() => {
                  setDisconnectError(null);
                  disconnect.reset();
                  setPassword("");
                  setDisconnectOpen(true);
                }}
              >
                {state === "pending" ? "Retry disconnect" : "Disconnect"}
              </Button>
            </SettingsRow>
          ) : null}
        </div>
      </SettingsCard>

      <ModalCard
        open={setOpen}
        title={tokenSet ? "Replace device token" : "Set device token"}
        onClose={() => setSetOpen(false)}
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
                setSetError(null);
              }}
              placeholder="7K4M-2Q9X-R8N3-6T5W-1PZH"
              aria-invalid={Boolean(tokenInput.trim() && !isValidDeviceToken(tokenInput))}
            />
          </div>
          {setError ? <PageNotice variant="error">{setError}</PageNotice> : null}
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
            <Button variant="outline" onClick={() => setSetOpen(false)} disabled={saveToken.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      </ModalCard>

      <ConfirmModal
        open={disconnectOpen}
        variant="danger"
        icon={TriangleAlert}
        title={state === "pending" ? "Retry disconnecting Luna Connect?" : "Disconnect Luna Connect?"}
        message="Remote access stops, and you can connect this Luna again later. Cloud backups stay in your Connect account."
        confirmLabel={state === "pending" ? "Retry disconnect" : "Disconnect"}
        loading={disconnect.isPending}
        disabledConfirm={!password.trim()}
        error={disconnectError}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={() => disconnect.mutate()}
        initialFocusRef={passwordRef}
      >
        <label className="block text-sm" htmlFor="disconnect-luna-password">
          <span className="block translate-x-5">Type your password to confirm</span>
        </label>
        <input
          id="disconnect-luna-password"
          type="password"
          autoComplete="current-password"
          className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
          value={password}
          ref={passwordRef}
          onChange={(e) => setPassword(e.target.value)}
        />
      </ConfirmModal>
    </>
  );
}

DeviceTokenCard.propTypes = { index: PropTypes.number };
