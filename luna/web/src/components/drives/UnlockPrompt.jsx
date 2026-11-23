import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import FormInput from "../common/forms/FormInput.jsx";
import { apiErrorMessage, postJson } from "../../lib/api.js";

/**
 * A small password prompt that opens a locked drive.
 *
 * - `driveId`: a drive Luna already has. Anyone who can see the drive may unlock it.
 * - `deviceName`: an encrypted drive Luna hasn't added yet (the Add-drive window,
 *   Admin only). Unlocking it also adds it.
 *
 * A wrong password is a field error: it shakes the field and paints its border
 * red. A busy drive or a lock-out after too many tries ("wait a few minutes";
 * lunad sends no clock, so none is shown) is a plain notice under the field —
 * neither says anything about what the person typed. Success is one toast.
 * The password lives only in this component's state and is cleared as soon as
 * it is sent.
 *
 * @param {{
 *   driveId?: string,
 *   deviceName?: string,
 *   onUnlocked?: (result: any) => void,
 *   beforeSend?: () => Promise<void> | void,
 *   surface?: "primary" | "secondary",
 *   buttonLabel?: string,
 * }} props
 */
export default function UnlockPrompt({ driveId, deviceName, onUnlocked, beforeSend, surface = "secondary", buttonLabel = "Unlock" }) {
  const client = useQueryClient();
  const { addToast } = useToast();
  const [password, setPassword] = useState("");
  // `error` belongs to the field (wrong password only — shake + red border).
  // `notice` is a plain line under it for a busy drive or a lock-out.
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const adding = Boolean(deviceName);
  const key = adding ? `add-${deviceName}` : driveId;

  const unlock = useMutation({
    mutationFn: async (/** @type {string} */ pw) => {
      // The Add-drive window's read-only look holds the disk; let go of it first.
      await beforeSend?.();
      return postJson(adding ? `/api/v1/drives/${encodeURIComponent(deviceName || "")}/unlock-and-add` : `/api/v1/drives/${driveId}/unlock`, { password: pw });
    },
    onSuccess: (result) => {
      addToast({ type: "success", message: adding ? "Drive unlocked and added." : "Drive unlocked." });
      setPassword("");
      setError("");
      for (const queryKey of [["drives"], ["drives-detected"], ["drive-summary", driveId], ["backups"], ["drive-encryption", driveId]]) {
        client.invalidateQueries({ queryKey });
      }
      onUnlocked?.(result);
    },
    onError: (err) => {
      const code = /** @type {any} */ (err)?.code;
      const message = apiErrorMessage(err, "Luna couldn't unlock this drive. Try again.");
      // Only a wrong password is a mistake in the field. A busy drive or too
      // many wrong tries is Luna's state, so it gets a plain notice instead.
      if (code === "wrong_password") {
        setNotice("");
        setError(message);
      } else {
        setError("");
        setNotice(message);
      }
    },
  });

  const submit = (/** @type {import("react").FormEvent} */ e) => {
    e.preventDefault();
    if (!password || unlock.isPending) return;
    setError("");
    setNotice("");
    unlock.mutate(password);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-slot="unlock-prompt">
      <FormInput
        label="Drive password"
        name={`unlock-${key}`}
        type="password"
        icon="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (error) setError("");
          if (notice) setNotice("");
        }}
        error={error}
        loading={unlock.isPending}
        surface={surface}
        className="mb-0"
      />
      {notice && <p className="text-sm">{notice}</p>}
      <div>
        <Button type="submit" size="sm" variant={surface === "primary" ? "secondary" : "primary"} surface={surface} loading={unlock.isPending} disabled={!password}>{buttonLabel}</Button>
      </div>
    </form>
  );
}

UnlockPrompt.propTypes = {
  driveId: PropTypes.string,
  deviceName: PropTypes.string,
  onUnlocked: PropTypes.func,
  beforeSend: PropTypes.func,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  buttonLabel: PropTypes.string,
};
