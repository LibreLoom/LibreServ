import { useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { House, KeyRound, Shield, Trash2, User, UserX } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import PasswordStrengthChecklist from "@libreloom/ui/components/common/PasswordStrengthChecklist.jsx";
import FieldLabel from "@libreloom/ui/components/common/forms/FieldLabel.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { meetsPasswordPolicy, passwordPolicyError } from "@libreloom/ui/lib/passwordPolicy.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { apiErrorMessage, deleteJson, getDrives, getJson, patchJson } from "../lib/api";
import { DISPLAY_NAME_MAX, USERNAME_POLICY_HINT, isValidUsername } from "../lib/usernamePolicy";
import { useAuth } from "../context/AuthContext";
import FormInput from "../components/common/forms/FormInput";

const ROLE_OPTIONS = [
  { value: "user", label: "Member" },
  { value: "admin", label: "Admin" },
];

const ROLE_HINTS = {
  admin: "An Admin manages people, drives and settings. Admins have their own private My files too, and can't open anyone else's.",
  user: "A Member has their own private My files and can use what's shared with them. They can't manage people, drives or settings.",
};

const USERS_PATH = "/settings/users";

/**
 * Full-page editor for one person on this Luna (Settings → Users → Edit).
 * Your own account is edited in Settings → Security, so self links redirect.
 */
export default function EditUserPage() {
  const { id } = useParams();
  const { user: me } = useAuth();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
  });

  if (id === me?.id) return <Navigate to="/settings#security" replace />;

  if (users.isLoading) return <Page title="Edit user" />;

  if (users.isError) {
    return (
      <Page title="Edit user">
        <PageNotice variant="error">
          {apiErrorMessage(users.error, "Couldn't load this person. Refresh the page to try again.")}
        </PageNotice>
      </Page>
    );
  }

  const target = (users.data || []).find((u) => u.id === id);
  if (!target) {
    return (
      <Page title="Edit user">
        <EmptyState
          icon={UserX}
          title="This person isn't on this Luna"
          description="They may have been removed. Go back to Users to see everyone who can sign in."
          action={
            <Button asChild variant="primary" size="sm">
              <Link to={USERS_PATH}>Back to Users</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  // Keyed so switching between people resets the form.
  return <EditUserForm key={target.id} target={target} />;
}

function EditUserForm({ target }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [name, setName] = useState(target.display_name || target.username);
  const [username, setUsername] = useState(target.username);
  const [role, setRole] = useState(target.role);
  const [password, setPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Safe default: keep the person's files unless the Admin picks otherwise.
  const [keepFiles, setKeepFiles] = useState(true);
  const [error, setError] = useState(null);
  const [removeError, setRemoveError] = useState(null);

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const homeDrive = (drives.data || []).find((d) => d.id === target.home_drive_id);

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
    onSuccess: () => {
      addToast({ type: "success", message: `Saved changes to ${nameClean}.` });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      navigate(USERS_PATH);
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, `Couldn't save changes to ${displayLabel}. Try again.`));
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteJson(`/api/v1/users/${target.id}${keepFiles ? "?keep_files=1" : ""}`),
    onSuccess: () => {
      addToast({ type: "success", message: `Removed ${displayLabel}.` });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      navigate(USERS_PATH);
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
    <Page title={`Edit ${displayLabel}`} titleId="edit-user-title">
      <form onSubmit={onSubmit} className="space-y-4" aria-labelledby="edit-user-title" noValidate>
        <SettingsCard icon={User} title="Profile" index={0}>
          <FormInput
            label="Name"
            name="edit-user-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name"
            error={nameError}
            hint="Shown around Luna, like on shared folders."
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
                ? `They'll sign in as "${usernameClean}" from now on. Their My files folder is renamed to match.`
                : "What they type to sign in."
            }
            required
            className="mb-0"
          />
        </SettingsCard>

        <SettingsCard icon={Shield} title="Role" index={1}>
          <div className="flex items-center gap-1">
            <FieldLabel htmlFor="edit-user-role" surface="secondary">
              What they can do on this Luna
            </FieldLabel>
            <InfoHint
              label="Admin and Member"
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
            aria-label="Role"
          />
          <p className="text-primary text-xs mt-2">{ROLE_HINTS[role] || ROLE_HINTS.user}</p>
        </SettingsCard>

        <SettingsCard icon={KeyRound} title="Password" index={2}>
          <p className="text-primary text-sm mb-3">
            Set a new password if {displayLabel} forgot theirs. You don't need their old one. Leave this blank to keep it.
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
            className="mb-0"
          />
          {password ? <PasswordStrengthChecklist password={password} /> : null}
          {password ? (
            <p className="text-primary text-xs mt-2">
              Saving signs {displayLabel} out on every device. Tell them the new password.
            </p>
          ) : null}
        </SettingsCard>

        <SettingsCard icon={House} title="Private folder" index={3}>
          <p className="text-primary text-sm">
            {homeDrive ? (
              <>
                {displayLabel}&apos;s{" "}
                <TermHint content="Each person's own folder, shown as My files. Other people on this Luna can't open it through Luna unless its owner shares something from inside it.">
                  My files
                </TermHint>{" "}
                folder is on {homeDrive.label}. Only they can open it.
              </>
            ) : (
              `${displayLabel} doesn't have a My files folder yet. Choose where private folders live under Private folders on the Users page.`
            )}
          </p>
        </SettingsCard>

        {error && <PageNotice variant="error">{error}</PageNotice>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline" surface="primary">
            <Link to={USERS_PATH}>Cancel</Link>
          </Button>
          <Button
            type="submit"
            variant="secondary"
            surface="primary"
            loading={save.isPending}
            disabled={invalid || !dirty}
          >
            Save changes
          </Button>
        </div>
      </form>

      <div className="mt-8">
        <SettingsCard icon={Trash2} title="Remove from this Luna" index={4}>
          <p className="text-primary text-sm mb-4">
            {displayLabel} won&apos;t be able to sign in anymore and loses access to everything shared with them.
            You&apos;ll choose what happens to their files next.
          </p>
          <Button
            variant="accent"
            onClick={() => {
              setRemoveError(null);
              setKeepFiles(true);
              setConfirmRemove(true);
            }}
          >
            Remove {displayLabel}
          </Button>
        </SettingsCard>
      </div>

      <ConfirmModal
        open={confirmRemove}
        title="Remove user"
        message={`Remove "${displayLabel}" from this Luna? They will lose access to shared drives.`}
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
      >
        <p className="text-sm mb-2">What should happen to their files?</p>
        <SegmentedControl
          surface="secondary"
          aria-label="What happens to their files"
          value={keepFiles ? "keep" : "delete"}
          onChange={(v) => setKeepFiles(v === "keep")}
          options={[
            { value: "keep", label: "Keep files" },
            { value: "delete", label: "Delete files" },
          ]}
        />
        <p className="text-sm mt-2">
          {keepFiles
            ? `Their files move into a shared folder named "${target.username}'s files" (Luna adds a number if that name is taken) that Admins can open.`
            : "Their files move to the drive's trash."}
        </p>
      </ConfirmModal>
    </Page>
  );
}
