import { useEffect, useState } from "react";
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
 * lunad sends no clock, so none is shown) is a plain, polite live notice under
 * the field — it neither shakes nor says anything about what was typed, but a
 * screen reader still hears it. Success is one toast.
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
  const inputId = `unlock-${key}`;
  const noticeId = `${inputId}-notice`;

  // FormInput owns `aria-describedby` when there is a field error (a wrong
  // password). For the plain busy/lock-out notice there is no error prop, so
  // attach it to the input ourselves; this never touches shake or red border.
  useEffect(() => {
    if (error) return undefined;
    const input = document.getElementById(inputId);
    if (!input) return undefined;
    if (notice) input.setAttribute("aria-describedby", noticeId);
    return () => {
      if (input.getAttribute("aria-describedby") === noticeId) {
        input.removeAttribute("aria-describedby");
      }
    };
  }, [inputId, noticeId, notice, error]);

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
        name={inputId}
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
      {notice && (
        <p id={noticeId} role="status" aria-live="polite" className="text-sm">{notice}</p>
      )}
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
