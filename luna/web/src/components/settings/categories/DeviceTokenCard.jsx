import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, TriangleAlert } from "lucide-react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { apiErrorMessage, deleteJson, getJson, postJson } from "../../../lib/api";
import { connectState } from "../../../lib/connectState.js";
import {
  formatDeviceUid,
  isValidDeviceUid,
  isValidVerificationCode,
  normalizeDeviceUid,
  normalizeVerificationCode,
} from "../../../lib/deviceIdentity.js";
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

/** Public Device ID plus Admin-only pairing controls for Luna Connect. */
export default function DeviceTokenCard({ index = 0 }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const isAdmin = useOptionalAuth()?.user?.role === "admin";
  const [showCode, setShowCode] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreUid, setRestoreUid] = useState("");
  const [restoreCode, setRestoreCode] = useState("");
  const [restoreError, setRestoreError] = useState(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState(null);
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

  const restoreDetails = useMutation({
    mutationFn: () => postJson("/api/v1/connect/device-token", {
      device_uid: normalizeDeviceUid(restoreUid),
      verification_code: normalizeVerificationCode(restoreCode),
    }),
    onSuccess: () => {
      addToast({ type: "success", message: "Pairing details restored." });
      setRestoreOpen(false);
      setRestoreError(null);
      setRestoreCode("");
      invalidate();
    },
    onError: (err) => setRestoreError(apiErrorMessage(err, "Couldn't restore the pairing details. Try again.")),
  });

  const removeCode = useMutation({
    mutationFn: () => deleteJson("/api/v1/connect/device-token"),
    onSuccess: () => {
      addToast({ type: "success", message: "Verification code removed." });
      setShowCode(false);
      setRemoveOpen(false);
      setRemoveError(null);
      invalidate();
    },
    onError: (err) => setRemoveError(apiErrorMessage(err, "Couldn't remove the Verification code. Try again.")),
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
  const deviceUid = formatDeviceUid(s.device_uid || "");
  const verificationCode = isAdmin ? String(s.verification_code || "").trim().toUpperCase() : "";
  const hasVerificationCode = Boolean(verificationCode);
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
            label="Device ID"
            description="Find this on Luna when pairing it in Luna Connect."
            stack
          >
            <div className="w-full lg:w-[24rem]">
              {deviceUid ? (
                <CopyableValue
                  value={deviceUid}
                  copyLabel="Copy ID"
                  ariaLabel="Device ID"
                  className="w-full"
                />
              ) : (
                <InlinePill>Not available</InlinePill>
              )}
            </div>
          </SettingsRow>

          <SettingsRow
            label="Verification code"
            description={isAdmin ? "Luna asks for this with the Device ID when pairing." : "An Admin can manage the Verification code."}
            stack
          >
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-[24rem]">
              {showCode && verificationCode ? (
                <CopyableValue
                  value={verificationCode}
                  copyLabel="Copy code"
                  ariaLabel="Verification code"
                  className="min-w-0 flex-1"
                />
              ) : (
                <InlinePill className="w-fit">{!isAdmin ? "Admin only" : verificationCode ? "••••••" : "Not available"}</InlinePill>
              )}
              {hasVerificationCode ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCode((shown) => !shown)}
                  disabled={!verificationCode}
                >
                  {showCode ? "Hide code" : "Show code"}
                </Button>
              ) : null}
            </div>
          </SettingsRow>

          {state === "unbound" ? (
            <SettingsRow
              label="Pair this Luna"
              description={isAdmin ? "Use both values above in your Luna Connect account." : "An Admin can pair this Luna from Luna Connect."}
              hideDivider
            >
              {isAdmin ? (
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
            <SettingsRow
              label="Restore pairing details"
              description="Use the Device ID and Verification code from your Connect account if either is missing."
              hideDivider
            >
              <Button
                variant="outline"
                disabled={state === "pending"}
                onClick={() => {
                  setRestoreError(null);
                  restoreDetails.reset();
                  setRestoreUid(deviceUid);
                  setRestoreCode(verificationCode);
                  setRestoreOpen(true);
                }}
              >
                Restore details
              </Button>
            </SettingsRow>
          ) : null}

          {hasVerificationCode ? (
            <SettingsRow
              label="Remove Verification code"
              description="Removes it only from Luna. Connect and remote access do not change."
              hideDivider
            >
              <Button
                variant="danger"
                onClick={() => {
                  setRemoveError(null);
                  removeCode.reset();
                  setRemoveOpen(true);
                }}
              >
                Remove code
              </Button>
            </SettingsRow>
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
        open={restoreOpen}
        title="Restore pairing details"
        onClose={() => setRestoreOpen(false)}
      >
        <div className="space-y-4">
          <p className="text-sm text-primary">
            Enter the original Device ID and Verification code from your Connect account. This does not change your Connect account.
          </p>
          <div className="space-y-1">
            <label className="block text-sm text-primary translate-x-5" htmlFor="restore-device-uid">
              Device ID
            </label>
            <input
              id="restore-device-uid"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="w-full rounded-pill surface-primary px-4 py-2 font-mono"
              value={restoreUid}
              onChange={(e) => {
                setRestoreUid(e.target.value.toUpperCase());
                setRestoreError(null);
              }}
              placeholder="****-****-****-****-****"
              aria-invalid={Boolean(restoreError && !isValidDeviceUid(restoreUid))}
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm text-primary translate-x-5" htmlFor="restore-verification-code">
              Verification code
            </label>
            <input
              id="restore-verification-code"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={6}
              className="w-full rounded-pill surface-primary px-4 py-2 font-mono"
              value={restoreCode}
              onChange={(e) => {
                setRestoreCode(e.target.value.toUpperCase());
                setRestoreError(null);
              }}
              placeholder="A3F91C"
              aria-invalid={Boolean(restoreError && !isValidVerificationCode(restoreCode))}
            />
          </div>
          {restoreError ? <PageNotice variant="error">{restoreError}</PageNotice> : null}
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              loading={restoreDetails.isPending}
              disabled={!isValidDeviceUid(restoreUid) || !isValidVerificationCode(restoreCode)}
              onClick={() => restoreDetails.mutate()}
            >
              Restore details
            </Button>
            <Button variant="outline" onClick={() => setRestoreOpen(false)} disabled={restoreDetails.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      </ModalCard>

      <ConfirmModal
        open={removeOpen}
        variant="warning"
        icon={TriangleAlert}
        title="Remove Verification code?"
        message="This removes only the Verification code from Luna. Connect and remote access do not change; you can restore it from Devices in your Connect account if Luna needs to pair again."
        confirmLabel="Remove code"
        loading={removeCode.isPending}
        error={removeError}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => removeCode.mutate()}
      />

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
