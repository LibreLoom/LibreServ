import { useState } from "react";
import PropTypes from "prop-types";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Settings2, Trash2, Users } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import { Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import AddPersonModal from "./AddPersonModal.jsx";
import CreateLinkModal from "./CreateLinkModal.jsx";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { deleteJson, getJson, patchJson, postJson, apiErrorMessage } from "../../lib/api";
import { isTrashPath } from "../../lib/paths.js";
import {
  CAP,
  CAP_MANAGE,
  capsBits,
  KIND_ALBUM,
  capsLabel,
  capsOptions,
  hasCap,
  joinShareCaps,
  splitShareCaps,
  subjectQuery,
  subjectKey,
} from "../../lib/access.js";
import { isFormFile } from "../../lib/fileKinds.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

function expiryLabel(expiresAt) {
  if (!expiresAt) return "never expires";
  const when = new Date(expiresAt * 1000);
  if (Number.isNaN(when.getTime())) return "expires";
  if (when.getTime() < Date.now()) return "expired";
  return `expires ${when.toLocaleDateString()}`;
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.users)) return data.users;
  return [];
}

/** @param {{ label: string, onClick: () => void, surface?: "primary"|"secondary" }} props */
export function ShareButton({ label, onClick, surface = "secondary" }) {
  return (
    <Tooltip content="Share">
      <Button
        variant="ghost"
        surface={surface}
        size="iconSm"
        aria-label={`Sharing for ${label}`}
        onClick={onClick}
      >
        <Users size={ICON_SIZE.sm} />
      </Button>
    </Tooltip>
  );
}

ShareButton.propTypes = {
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};

/**
 * The universal share sheet — one surface for every shareable thing:
 * files, folders, whole drives, and albums. "People" holds Luna-user
 * members; "Links" holds public `/s/` links. Both use the same capability
 * vocabulary; the sheet only ever offers levels valid for this subject and
 * covered by the caller's own access.
 *
 * @param {{
 *   subject: import("../../lib/access.js").ShareSubject | null,
 *   open?: boolean,
 *   onClose: () => void,
 *   overlayClassName?: string,
 * }} props
 */
export default function ShareSheet(props) {
  return <ShareSheetSession key={JSON.stringify(subjectKey(props.subject))} {...props} />;
}

function ShareSheetSession({ subject, open = true, onClose, overlayClassName = undefined }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [error, setError] = useState(null);
  const [creatingLink, setCreatingLink] = useState(false);
  const [editingLink, setEditingLink] = useState(null);
  const [removingLink, setRemovingLink] = useState(null);
  const [linkError, setLinkError] = useState(null);
  const [addingPerson, setAddingPerson] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  const [parentSubject, setParentSubject] = useState(null);

  const key = subjectKey(subject);
  const stateQuery = useQuery({
    queryKey: ["access-subject", ...key],
    queryFn: () => getJson(`/api/v1/access/subject?${subjectQuery(subject)}`),
    enabled: open && !!subject?.driveId,
    retry: false,
  });
  const directory = useQuery({
    queryKey: ["users-directory"],
    queryFn: () => getJson("/api/v1/users/directory"),
    enabled: open,
    retry: false,
  });

  const data = stateQuery.data;
  const subj = data?.subject || null;
  const myCaps = data?.my_caps || "";
  // Managing the roster — adding people, minting links, retuning grants —
  // needs the share bit, not just content rights.
  const iCanShare = hasCap(myCaps, CAP.SHARE);
  const isAlbum = subj?.kind === KIND_ALBUM;
  const isFile = subj?.is_file === true || subject?.isFile === true;
  const isForm = isFile && isFormFile(subj?.path || "");
  const memberOptions = capsOptions(
    { kind: subj?.kind, isFile },
    myCaps,
  );
  const members = data?.members || [];
  const links = data?.links || [];
  // A private item (or one inside a private folder) takes nothing from
  // folders above it; Luna only sends the shares that still reach in.
  const isPrivate = subj?.private === true;
  // This folder is itself the boundary — vs. an ordinary thing inside one.
  const isPrivateFolder = subj?.private_folder === true;
  const iAmOwner = isPrivateFolder && subj?.owner === user?.id;
  // Folders can change their own privacy: managers draw the boundary, the
  // owner (or an Admin when nobody owns it) lifts it.
  const canMakePrivate =
    subj?.kind === KIND_ALBUM || isFile || isPrivateFolder || !subj?.exists || isTrashPath(subj?.path || "")
      ? false
      : (capsBits(myCaps) & CAP_MANAGE) === CAP_MANAGE;
  const canOpenPrivate =
    isPrivateFolder &&
    (iAmOwner || (user?.role === "admin" && !subj?.owner));
  const [privacyAsk, setPrivacyAsk] = useState(/** @type {null|"make"|"open"} */ (null));
  const inheritedMembers = data?.inherited_members || [];
  const inheritedLinks = data?.inherited_links || [];
  // Unique parents carrying grants this subject inherits — deduped across
  // the member and link lists so one parent gets one button.
  const parentByKey = new Map();
  for (const row of [...inheritedMembers, ...inheritedLinks]) {
    const from = row.inherited_from;
    if (!from?.drive_id) continue;
    parentByKey.set(`${from.kind}:${from.drive_id}:${from.path}`, from);
  }
  const parentSources = [...parentByKey.values()];
  const inspectableParents = parentSources.filter((p) => p.can_inspect !== false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["access-subject"] });
    queryClient.invalidateQueries({ queryKey: ["access-mine"] });
    queryClient.invalidateQueries({ queryKey: ["my-access"] });
    queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
  };

  const updateMember = useMutation({
    mutationFn: (/** @type {{ id: string, caps: string }} */ vars) =>
      patchJson(`/api/v1/access/members/${vars.id}`, { caps: vars.caps }),
    onMutate: ({ id }) => setUpdatingId(id),
    onSuccess: () => {
      addToast({ type: "success", message: "Access updated." });
      invalidate();
      setError(null);
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't change that person's access. Try again."));
    },
    onSettled: () => setUpdatingId(null),
  });
  const removeMember = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/access/members/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Access removed." });
      invalidate();
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't remove that person's access. Try again."));
    },
  });
  const privacyMutation = useMutation({
    mutationFn: (/** @type {boolean} */ makePrivate) =>
      postJson(`/api/v1/drives/${subj.drive_id}/files/privacy`, {
        path: subj.path,
        private: makePrivate,
      }),
    onSuccess: (_d, makePrivate) => {
      addToast({
        type: "success",
        message: makePrivate
          ? "Folder is private now."
          : "Folder uses its parent's access now.",
      });
      setPrivacyAsk(null);
      setError(null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't change that folder's privacy. Try again."));
      setPrivacyAsk(null);
    },
  });
  const removeLink = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/access/links/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Link removed." });
      invalidate();
      setRemovingLink(null);
      setLinkError(null);
    },
    onError: (err) => {
      haptic("error");
      setLinkError(apiErrorMessage(err, "Couldn't remove that link."));
    },
  });

  const memberUserIds = new Set(members.map((m) => m.user_id));
  const others = asList(directory.data).filter((u) => u.shareable !== false && u.id !== user?.id);
  // Admins already open ordinary items, so the server refuses a member row
  // for one there. A private item is the exception: Admins are people to
  // share with like anyone else.
  const candidates = isPrivate ? others : others.filter((u) => u.admin !== true);
  const people = candidates.filter((u) => !memberUserIds.has(u.id));
  const noPeopleToAdd = directory.isSuccess && people.length === 0;
  const sheetError =
    error ||
    (stateQuery.isError
      ? apiErrorMessage(stateQuery.error, "You don't have access to share this.")
      : null);

  return (
    <>
      <ModalCard open={open} title="Sharing" onClose={onClose} overlayClassName={overlayClassName}>
        <div className="space-y-5" data-slot="share-sheet">
          {(subj?.name || subject?.name) && (
            <div className="rounded-large-element surface-primary p-3">
              <p className="text-xs font-mono">
                {isAlbum
                  ? "Album"
                  : isFile
                    ? "File"
                    : (subj?.path ?? subject?.path)
                      ? "Folder"
                      : "Drive"}
              </p>
              <p className="mt-1 font-mono text-base text-secondary break-all">
                {subj?.name || subject?.name}
              </p>
            </div>
          )}
          {isPrivate && (
            <p className="flex items-start gap-2 rounded-large-element surface-primary p-3 text-secondary text-sm" data-slot="private-note">
              <Lock size={ICON_SIZE.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {isPrivateFolder
                  ? "Private folder: only people added here can open it. Sharing a folder above it doesn't include it."
                  : "In a private folder: only people added to that folder can open this."}
              </span>
            </p>
          )}
          {(canMakePrivate || canOpenPrivate) && (
            <div className="rounded-large-element surface-primary p-3 space-y-2">
              {canMakePrivate && (
                <>
                  <p className="text-secondary text-sm">
                    Make this folder private to you. Shares on folders above
                    it stop reaching in; shares here keep working.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    surface="primary"
                    onClick={() => setPrivacyAsk("make")}
                  >
                    <Lock size={ICON_SIZE.xs} aria-hidden="true" />
                    Make private
                  </Button>
                </>
              )}
              {canOpenPrivate && (
                <>
                  <p className="text-secondary text-sm">
                    This is a private folder. You can open it so it uses the
                    same access as the folder it sits in.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    surface="primary"
                    onClick={() => setPrivacyAsk("open")}
                  >
                    Use parent access
                  </Button>
                </>
              )}
            </div>
          )}
          {parentSources.length > 0 && (
            <div className="space-y-2 rounded-large-element surface-primary p-3">
              <p className="text-secondary text-xs">
                {inheritedMembers.length > 0 &&
                  `${inheritedMembers.length} ${inheritedMembers.length === 1 ? "person" : "people"}`}
                {inheritedMembers.length > 0 && inheritedLinks.length > 0 && " and "}
                {inheritedLinks.length > 0 &&
                  `${inheritedLinks.length} ${inheritedLinks.length === 1 ? "link" : "links"}`}
                {" shared through "}
                {parentSources.map((p) => p.name).join(", ")}
              </p>
              {inspectableParents.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {inspectableParents.map((p) => (
                    <Button
                      key={`${p.kind}:${p.drive_id}:${p.path}`}
                      variant="outline"
                      surface="primary"
                      size="sm"
                      onClick={() =>
                        setParentSubject({
                          kind: p.kind,
                          driveId: p.drive_id,
                          path: p.path || "",
                          albumId: "",
                          name: p.name,
                        })
                      }
                    >
                      {inspectableParents.length === 1
                        ? "View parent shares"
                        : `View ${p.name} shares`}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
          {sheetError && <PageNotice variant="error">{sheetError}</PageNotice>}
          {stateQuery.isLoading && (
            <div className="flex items-center gap-2 py-2 text-primary" role="status">
              <Spinner size="sm" decorative />
              <p className="text-sm">Loading…</p>
            </div>
          )}

          {subj && (
            <>
              <section className="space-y-2">
                <h3 className="font-mono text-primary text-sm">People</h3>
                {members.map((m) => {
                  // The server decides manageability per row — never
                  // infer it from capability math here (equal-cap peers
                  // can't retune each other, and a plain member can't
                  // touch anyone's grant).
                  const canManage = m.can_manage === true && iCanShare;
                  const canRemove = m.can_remove === true;
                  // The share bit rides alongside the content level —
                  // editing splits them so the dropdown stays content-only.
                  const grant = splitShareCaps(m.caps);
                  const options = canManage
                    ? [...new Set([grant.content, ...memberOptions.map((o) => o.value)])].map((v) => ({
                        value: v,
                        label: capsLabel(v, { album: isAlbum, file: isFile }),
                      }))
                    : [];
                  return (
                    <div
                      key={m.id}
                      className="rounded-large-element surface-primary p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                          <span className="text-secondary text-xs truncate">{m.name}</span>
                          {canManage ? (
                            <Dropdown
                              options={options}
                              value={grant.content}
                              onChange={(next) => {
                                const joined = joinShareCaps(next, grant.share);
                                if (joined !== m.caps) updateMember.mutate({ id: m.id, caps: joined });
                              }}
                              disabled={updatingId === m.id}
                              aria-label={`Access for ${m.name}`}
                              bg="secondary"
                            />
                          ) : (
                            <span className="text-secondary text-xs">
                              {capsLabel(m.caps, { album: isAlbum, file: isFile })}
                            </span>
                          )}
                        </div>
                        {canRemove && (
                          <Button
                            size="iconSm"
                            variant="danger"
                            aria-label={`Remove access for ${m.name}`}
                            loading={removeMember.isPending && removeMember.variables === m.id}
                            onClick={() => removeMember.mutate(m.id)}
                          >
                            <Trash2 size={ICON_SIZE.xs} />
                          </Button>
                        )}
                      </div>
                      {canManage && (
                        <Toggle
                          surface="primary"
                          checked={grant.share}
                          disabled={updatingId === m.id}
                          onChange={(next) =>
                            updateMember.mutate({ id: m.id, caps: joinShareCaps(grant.content, next) })
                          }
                          label="Can share"
                          description="They can pass this access on and create links."
                          className="mt-2"
                        />
                      )}
                      {m.effective_caps && m.effective_caps !== m.caps && (
                        <p className="text-secondary text-xs mt-1">
                          Also has {capsLabel(m.effective_caps, { album: isAlbum, file: isFile })} through a parent folder.
                        </p>
                      )}
                    </div>
                  );
                })}
                {noPeopleToAdd ? (
                  <div className="space-y-3 rounded-large-element surface-primary p-3">
                    <p className="text-secondary text-sm">
                      {candidates.length > 0
                        ? "Everyone already has access."
                        : others.length > 0
                          ? "Admins can already open everything except other people's private items."
                          : "No people to share with yet."}
                    </p>
                    {user?.role === "admin" && (
                      <Button variant="secondary" surface="primary" size="sm" asChild>
                        <Link to="/settings/users" onClick={onClose}>
                          Go to Users
                        </Link>
                      </Button>
                    )}
                  </div>
                ) : (
                  memberOptions.length > 0 && iCanShare && directory.isSuccess && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        setError(null);
                        setAddingPerson(true);
                      }}
                    >
                      Add a person
                    </Button>
                  )
                )}
              </section>

              <section className="space-y-2">
                <h3 className="font-mono text-primary text-sm">Links</h3>
                {links.map((l) => {
                  // Server-issued `can_manage` only — a URL's presence is
                  // already gated the same way, but the flag is the
                  // contract, never inference from visible fields.
                  const canManage = l.can_manage === true;
                  const url = canManage && l.url ? window.location.origin + l.url : null;
                  return (
                    <div
                      key={l.id}
                      className="rounded-large-element surface-primary p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-secondary text-xs min-w-0">
                          {capsLabel(l.caps, { album: isAlbum, file: isFile })}
                          {l.has_password ? " · Password" : " · Anyone with the link"}
                          {" · "}
                          {expiryLabel(l.expires_at)}
                        </p>
                        {canManage && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              size="iconSm"
                              variant="ghost"
                              surface="primary"
                              aria-label="Link settings"
                              onClick={() => {
                                setLinkError(null);
                                setEditingLink(l);
                              }}
                            >
                              <Settings2 size={ICON_SIZE.xs} />
                            </Button>
                            <Button
                              size="iconSm"
                              variant="danger"
                              aria-label="Remove this link"
                              onClick={() => {
                                setLinkError(null);
                                setRemovingLink(l);
                              }}
                            >
                              <Trash2 size={ICON_SIZE.xs} />
                            </Button>
                          </div>
                        )}
                      </div>
                      {url && (
                        <CopyableValue
                          className="mt-2"
                          value={url}
                          copyLabel="Copy address"
                          ariaLabel="Share link address"
                          surface="primary"
                        />
                      )}
                    </div>
                  );
                })}
                {iCanShare && capsOptions({ kind: subj?.kind, isFile, isForm }, myCaps, { forLink: true }).length > 0 && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setError(null);
                      setCreatingLink(true);
                    }}
                  >
                    New link
                  </Button>
                )}
              </section>
            </>
          )}
        </div>
      </ModalCard>
      {addingPerson && subj && (
        <AddPersonModal
          open
          subject={subj}
          people={people}
          options={memberOptions}
          hintFor={{ album: isAlbum, file: isFile, form: isForm }}
          overlayClassName={overlayClassName || NESTED_OVERLAY_CLASS}
          onClose={() => setAddingPerson(false)}
          onDone={() => {
            setAddingPerson(false);
            invalidate();
          }}
        />
      )}
      {creatingLink && subj && (
        <CreateLinkModal
          open
          subject={subj}
          myCaps={myCaps}
          overlayClassName={overlayClassName || NESTED_OVERLAY_CLASS}
          onClose={() => setCreatingLink(false)}
          onDone={() => {
            setCreatingLink(false);
            invalidate();
          }}
        />
      )}
      {editingLink && subj && (
        <CreateLinkModal
          open
          link={editingLink}
          subject={subj}
          myCaps={myCaps}
          overlayClassName={overlayClassName || NESTED_OVERLAY_CLASS}
          onClose={() => setEditingLink(null)}
          onDone={() => {
            setEditingLink(null);
            invalidate();
          }}
        />
      )}
      <ConfirmModal
        open={removingLink != null}
        title="Remove link?"
        variant="danger"
        confirmLabel="Remove link"
        loading={removeLink.isPending}
        error={linkError}
        overlayClassName={overlayClassName || NESTED_OVERLAY_CLASS}
        onClose={() => {
          setRemovingLink(null);
          setLinkError(null);
        }}
        onConfirm={() => removingLink && removeLink.mutate(removingLink.id)}
      >
        <p className="text-primary text-sm">
          Anyone using this link will lose access.
        </p>
      </ConfirmModal>
      <ConfirmModal
        open={privacyAsk != null}
        title={privacyAsk === "make" ? "Make this folder private?" : "Use parent access?"}
        variant={privacyAsk === "open" ? "danger" : "warning"}
        confirmLabel={privacyAsk === "make" ? "Make private" : "Use parent access"}
        loading={privacyMutation.isPending}
        overlayClassName={overlayClassName || NESTED_OVERLAY_CLASS}
        onClose={() => !privacyMutation.isPending && setPrivacyAsk(null)}
        onConfirm={() => privacyMutation.mutate(privacyAsk === "make")}
      >
        <p className="text-primary text-sm">
          {privacyAsk === "make"
            ? "Only you — and anyone you share it with here — will be able to open this folder. People who reach it through a folder above lose access. Private folders inside it stay private."
            : "Everyone with access to the folder above will be able to open this folder too. Private folders inside it stay private."}
        </p>
      </ConfirmModal>
      {parentSubject && (
        <ShareSheet
          open
          subject={parentSubject}
          overlayClassName={NESTED_OVERLAY_CLASS}
          onClose={() => setParentSubject(null)}
        />
      )}
    </>
  );
}

ShareSheet.propTypes = {
  subject: PropTypes.shape({
    kind: PropTypes.string,
    driveId: PropTypes.string,
    path: PropTypes.string,
    albumId: PropTypes.string,
    name: PropTypes.string,
  }),
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  overlayClassName: PropTypes.string,
};

ShareSheetSession.propTypes = ShareSheet.propTypes;
