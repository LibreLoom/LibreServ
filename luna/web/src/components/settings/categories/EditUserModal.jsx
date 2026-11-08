import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Shield, Trash2, User } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import PasswordStrengthChecklist from "@libreloom/ui/components/common/PasswordStrengthChecklist.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { meetsPasswordPolicy, passwordPolicyError } from "@libreloom/ui/lib/passwordPolicy.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { apiErrorMessage, deleteJson, getJson, patchJson } from "../../../lib/api";
import { DISPLAY_NAME_MAX, USERNAME_POLICY_HINT, isValidUsername } from "../../../lib/usernamePolicy";
import FormInput from "../../common/forms/FormInput";

const ROLE_OPTIONS = [
  { value: "user", label: "Member" },
  { value: "admin", label: "Admin" },
];

const ROLE_HINTS = {
  admin: "An Admin can add users, change settings, manage drives, and open everything on this Luna except other people's private items.",
  user: "A Member can use folders and albums shared with them. They cannot manage users, drives, or Luna settings.",
};

/**
 * Edit one other person on this Luna, in the same modal shape as Add a user.
 * Your own account is edited in Settings → Security, so this is only mounted
 * for someone else (the Users list opens it from the row).
 *
 * @param {{
 *   target: { id: string, username: string, display_name?: string, role: string } | null,
 *   onClose: () => void,
 * }} props
 */
export default function EditUserModal({ target, onClose }) {
  return (
    <ModalCard
      open={target != null}
      title={target ? `Edit ${target.display_name || target.username}` : "Edit user"}
      onClose={onClose}
      size="lg"
    >
      {target ? <EditUserBody key={target.id} target={target} onClose={onClose} /> : null}
    </ModalCard>
  );
}

function EditUserBody({ target, onClose }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [name, setName] = useState(target.display_name || target.username);
  const [username, setUsername] = useState(target.username);
  const [role, setRole] = useState(target.role);
  const [password, setPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState(null);
  const [removeError, setRemoveError] = useState(null);

  const displayLabel = target.display_name || target.username;
  const nameClean = name.trim();
  const usernameClean = username.trim().toLowerCase();
  const nameError = !nameClean
    ? "They need a name."
    : nameClean.length > DISPLAY_NAME_MAX
      ? `Names are 1-${DISPLAY_NAME_MAX} characters.`
      : null;
  const usernameError = !usernameClean
    ? "They need a username to sign in."
    : !isValidUsername(usernameClean)
      ? USERNAME_POLICY_HINT
      : null;
  const passwordProblem = password && !meetsPasswordPolicy(password)
    ? passwordPolicyError(password) || "Choose a stronger password."
    : null;
  const invalid = Boolean(nameError || usernameError || passwordProblem);

  const changes = {};
  if (nameClean !== (target.display_name || "")) changes.display_name = nameClean;
  if (usernameClean !== target.username) changes.username = usernameClean;
  if (role !== target.role) changes.role = role;
  if (password) changes.password = password;
  const dirty = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => patchJson(`/api/v1/users/${target.id}`, changes),
    onSuccess: (data) => {
      // A password Luna could not check against known breaches is reported,
      // not silently accepted.
      addToast({
        type: data?.warning ? "info" : "success",
        message: `Saved changes to ${nameClean}.`,
        description: data?.warning || undefined,
        duration: data?.warning ? 10000 : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, `Couldn't save changes to ${displayLabel}. Try again.`));
    },
  });

  // Removing someone keeps their private folders on the drives, hidden from
  // everyone — say how many before confirming.
  const privateCountQuery = useQuery({
    queryKey: ["user-private-count", target.id],
    queryFn: () => getJson(`/api/v1/users/${target.id}/private-count`),
    enabled: confirmRemove,
    retry: false,
  });
  const privateCount = Number(privateCountQuery.data?.count) || 0;

  const remove = useMutation({
    mutationFn: () => deleteJson(`/api/v1/users/${target.id}`),
    onSuccess: () => {
      addToast({ type: "success", message: `Removed ${displayLabel}.` });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["private-orphans"] });
      onClose();
    },
    onError: (err) => {
      haptic("error");
      setRemoveError(apiErrorMessage(err, `Couldn't remove ${displayLabel}. Try again.`));
    },
  });

  function onSubmit(event) {
    event.preventDefault();
    if (invalid || !dirty || save.isPending) return;
    setError(null);
    save.mutate();
  }

  return (
    <>
      <form id="edit-user-form" onSubmit={onSubmit} className="space-y-5" noValidate>
        <section className="rounded-large-element surface-primary p-4 space-y-3">
          <h3 className="font-mono text-sm">Profile</h3>
          <FormInput
            label="Name"
            name="edit-user-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name"
            error={nameError}
            hint="Shown around Luna, like on shared folders."
            surface="primary"
            required
          />
          <FormInput
            label="Username"
            name="edit-user-username"
            icon="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            error={usernameError}
            hint={
              usernameClean !== target.username
                ? `They'll sign in as "${usernameClean}" from now on.`
                : "What they type to sign in."
            }
            surface="primary"
            required
          />
        </section>

        <section className="rounded-large-element surface-primary p-4 space-y-3">
          <h3 className="font-mono text-sm">Role</h3>
          <div className="flex items-center gap-1 pl-5">
            <label htmlFor="edit-user-role" className="font-mono text-sm text-secondary">
              What they can do on this Luna
            </label>
            <InfoHint
              label="Admin and Member"
              surface="primary"
              content={`${ROLE_HINTS.admin} ${ROLE_HINTS.user}`}
            />
          </div>
          <Dropdown
            id="edit-user-role"
            options={ROLE_OPTIONS}
            value={role}
            onChange={setRole}
            fullWidth
            size="form"
            bg="primary"
            aria-label="Role"
          />
          <p className="text-sm">{ROLE_HINTS[role] || ROLE_HINTS.user}</p>
        </section>

        <section className="rounded-large-element surface-primary p-4 space-y-3">
          <h3 className="font-mono text-sm">Password</h3>
          <p className="text-sm">
            Set a new password if {displayLabel} forgot theirs. You don't need their old one. Leave
            this blank to keep it.
          </p>
          <FormInput
            label="New password"
            name="edit-user-password"
            type="password"
            icon="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank to keep the current password"
            autoComplete="new-password"
            surface="primary"
          />
          {password ? <PasswordStrengthChecklist password={password} surface="primary" /> : null}
          {password ? (
            <p className="text-sm">
              Saving signs {displayLabel} out on every device. Tell them the new password.
            </p>
          ) : null}
        </section>

        {error ? <PageNotice variant="error">{error}</PageNotice> : null}

        <section className="rounded-large-element surface-primary p-4 space-y-3">
          <h3 className="font-mono text-sm">Remove from this Luna</h3>
          <p className="text-sm">
            {displayLabel} won't be able to sign in anymore and loses access to everything shared
            with them.
          </p>
          <Button
            variant="accent"
            onClick={() => {
              setRemoveError(null);
              setConfirmRemove(true);
            }}
          >
            Remove {displayLabel}
          </Button>
        </section>
      </form>

      <ConfirmModal
        open={confirmRemove}
        title="Remove user"
        disabledConfirm={privateCountQuery.isPending || privateCountQuery.isError}
        message={`Remove "${displayLabel}" from this Luna? They will lose access to shared drives.${
          privateCountQuery.isError ? " Luna couldn't check for their private folders, so removing is paused. Close this and try again." : ""
        }${
          privateCount > 0
            ? ` Their ${privateCount === 1 ? "1 private folder stays" : `${privateCount} private folders stay`} on the drives, hidden from everyone — you can delete them under "Private folders left behind" on the Users page.`
            : ""
        }`}
        confirmLabel="Remove"
        variant="danger"
        icon={User}
        loading={remove.isPending}
        error={removeError}
        onConfirm={() => remove.mutate()}
        onClose={() => {
          setConfirmRemove(false);
          setRemoveError(null);
        }}
        overlayClassName={NESTED_OVERLAY_CLASS}
      />

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" surface="secondary" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="edit-user-form"
          variant="primary"
          surface="secondary"
          loading={save.isPending}
          disabled={invalid || !dirty}
        >
          Save changes
        </Button>
      </div>
    </>
  );
}
