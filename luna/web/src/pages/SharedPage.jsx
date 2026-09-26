import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { File as FileIcon, Folder, Image as ImageIcon, Search, Share2 } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import ShareSheet from "../components/share/ShareSheet.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { apiErrorMessage, deleteJson, getJson } from "../lib/api";
import {
  KIND_ALBUM,
  capsLabel,
  shareSubjectFromRow,
  sharedItemAction,
  sharedItemHref,
} from "../lib/access.js";
import { isMemberHomePath } from "../lib/paths.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

function SubjectIcon({ kind, isFile }) {
  const Icon = kind === KIND_ALBUM ? ImageIcon : isFile ? FileIcon : Folder;
  return <Icon size={18} className="text-accent shrink-0" aria-hidden="true" />;
}

function subjectSubtitle(row, ownHomePath = "") {
  if (row.kind === KIND_ALBUM) return `Album · ${row.drive_label}`;
  if (row.is_home) return "Your private folder";
  // Inside the viewer's own home: "Home · docs" — the internal
  // `.luna-<uuid>-members/<name>` prefix never renders. Inside someone
  // else's home (a deep share) it reads "<name>'s home".
  if (isMemberHomePath(row.path)) {
    const segs = String(row.path).split("/");
    const rest = segs.slice(2).join("/");
    const owner = segs[1];
    if (ownHomePath && segs.slice(0, 2).join("/") === ownHomePath) {
      return rest ? `Home · ${rest}` : "Home";
    }
    return rest
      ? `${row.drive_label} · ${owner}'s home · ${rest}`
      : `${row.drive_label} · ${owner}'s home`;
  }
  if (row.path) return `${row.drive_label} · ${row.path}`;
  // Whole-drive grants name the drive in the header — don't repeat it.
  return "Whole drive";
}

function CapsPill({ caps, album, file }) {
  const variant = caps === "full" ? "success" : caps === "upload" ? "warning" : "info";
  return <Pill variant={variant}>{capsLabel(caps, { album, file })}</Pill>;
}

export default function SharedPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [managing, setManaging] = useState(null);
  const [leaving, setLeaving] = useState(null);
  const [leaveError, setLeaveError] = useState(null);
  const [chosenTab, setChosenTab] = useState(null);
  const [search, setSearch] = useState("");

  const mine = useQuery({
    queryKey: ["access-mine"],
    queryFn: () => getJson("/api/v1/access/mine"),
  });

  const leave = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/access/members/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "You left the share." });
      setLeaving(null);
      setLeaveError(null);
      queryClient.invalidateQueries({ queryKey: ["access-mine"] });
      queryClient.invalidateQueries({ queryKey: ["my-access"] });
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (err) => {
      haptic("error");
      setLeaveError(apiErrorMessage(err, "Couldn't leave that share. Try again."));
    },
  });

  const sharing = mine.data?.sharing || [];
  const withMe = mine.data?.with_me || [];
  const tab = chosenTab ?? (isAdmin && withMe.length === 0 ? "manage" : "with_me");
  const query = search.trim().toLowerCase();
  const matches = (row) =>
    !query
    || (row.name || "").toLowerCase().includes(query)
    || (row.path || "").toLowerCase().includes(query)
    || (row.drive_label || "").toLowerCase().includes(query);
  const shownWithMe = withMe.filter(matches);
  const shownSharing = sharing.filter(matches);

  return (
    <Page title="Shared" titleId="shared-title">
      {mine.isLoading && (
        <div className="flex items-center gap-2 py-4 text-secondary" role="status">
          <Spinner size="sm" decorative />
          <p className="text-sm">Loading…</p>
        </div>
      )}
      {mine.isError && (
        <PageNotice variant="error">
          {apiErrorMessage(mine.error, "Couldn't load sharing. Refresh and try again.")}
        </PageNotice>
      )}

      {mine.isSuccess && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <SegmentedControl
              surface="primary"
              value={tab}
              onChange={setChosenTab}
              aria-label="Shared items"
              options={[
                { value: "with_me", label: "Shared with you" },
                { value: "manage", label: "Manage sharing" },
              ]}
            />
            <label className="flex min-w-48 flex-1 items-center gap-2 rounded-pill border-2 border-transparent bg-secondary text-primary px-3 py-1 focus-within:border-accent motion-safe:transition-colors">
              <Search size={14} className="shrink-0 text-accent" aria-hidden="true" />
              <input
                type="text"
                className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-primary shadow-none outline-none focus-visible:outline-2 focus-visible:outline-accent placeholder:text-accent"
                placeholder="Find a shared item"
                aria-label="Find a shared item"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
          </div>

          {tab === "with_me" && (
            shownWithMe.length === 0 ? (
              <EmptyState
                icon={Share2}
                title={query ? "Nothing matches" : "Nothing shared with you yet"}
                description={query
                  ? `Nothing shared with you matches "${search.trim()}".`
                  : "When someone shares a file, folder, drive, or album with you, it lands here."}
              />
            ) : (
              <Card
                surface="primary"
                padding={false}
                noPopIn
                noHeightAnim
                className="overflow-hidden border-0 md:border-2 bg-transparent md:bg-primary"
              >
                <div className="overflow-x-auto">
                  <Table
                    columns={[
                      {
                        key: "item",
                        label: "Item",
                        render: (row) => (
                          <span className="flex min-w-0 items-center gap-2.5">
                            <SubjectIcon kind={row.kind} isFile={row.is_file} />
                            <span className="min-w-0 text-sm truncate">{row.name}</span>
                          </span>
                        ),
                      },
                      {
                        key: "where",
                        label: "Where",
                        render: (row) => subjectSubtitle(row, user?.home?.path || ""),
                      },
                      {
                        key: "access",
                        label: "Access",
                        render: (row) => (
                          <CapsPill
                            caps={row.caps}
                            album={row.kind === KIND_ALBUM}
                            file={row.is_file}
                          />
                        ),
                      },
                      {
                        key: "shared_by",
                        label: "Shared by",
                        render: (row) => row.shared_by || "—",
                      },
                      {
                        key: "actions",
                        label: "Actions",
                        srOnly: true,
                        align: "right",
                        noRowClick: true,
                        render: (row) => (
                          <span className="flex items-center justify-end gap-2">
                            {row.exists !== false ? (
                              <Button size="sm" variant="primary" asChild>
                                <Link to={sharedItemHref(row)}>{sharedItemAction(row)}</Link>
                              </Button>
                            ) : (
                              <span className="text-primary text-xs">Unavailable</span>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              surface="secondary"
                              onClick={() => {
                                setLeaveError(null);
                                setLeaving(row);
                              }}
                            >
                              Leave
                            </Button>
                          </span>
                        ),
                      },
                    ]}
                    data={shownWithMe}
                    rowKey="id"
                    mobileCards
                    striped
                    onRowClick={(row) => {
                      if (row.exists !== false) navigate(sharedItemHref(row));
                    }}
                  />
                </div>
              </Card>
            )
          )}

          {tab === "manage" && (
            shownSharing.length === 0 ? (
              <EmptyState
                icon={Share2}
                title={query ? "Nothing matches" : "Nothing shared yet"}
                description={query
                  ? `Nothing you manage matches "${search.trim()}".`
                  : "Use the share button on a file, folder, drive, or album — everything you share lands here."}
              />
            ) : (
              <Card
                surface="primary"
                padding={false}
                noPopIn
                noHeightAnim
                className="overflow-hidden border-0 md:border-2 bg-transparent md:bg-primary"
              >
                <div className="overflow-x-auto">
                  <Table
                    columns={[
                      {
                        key: "item",
                        label: "Item",
                        render: (s) => (
                          <span className="flex min-w-0 items-center gap-2.5">
                            <SubjectIcon kind={s.kind} isFile={s.is_file} />
                            <span className="min-w-0">
                              <span className="block font-mono text-sm truncate">
                                {s.name || s.path || s.drive_label}
                              </span>
                              {!s.exists && (
                                <span className="block text-xs text-warning">
                                  Not available right now
                                </span>
                              )}
                            </span>
                          </span>
                        ),
                      },
                      {
                        key: "where",
                        label: "Where",
                        render: (s) => subjectSubtitle(s, user?.home?.path || ""),
                      },
                      {
                        key: "shared",
                        label: "Shared with",
                        render: (s) => (
                          <span className="flex flex-wrap gap-1">
                            {s.members?.length > 0 && (
                              <Pill variant="info">
                                {s.members.length} {s.members.length === 1 ? "person" : "people"}
                              </Pill>
                            )}
                            {s.links?.length > 0 && (
                              <Pill variant="success">
                                {s.links.length} {s.links.length === 1 ? "link" : "links"}
                              </Pill>
                            )}
                          </span>
                        ),
                      },
                      {
                        key: "actions",
                        label: "Actions",
                        srOnly: true,
                        align: "right",
                        noRowClick: true,
                        render: (s) => (
                          <Button
                            size="sm"
                            variant="outline"
                            surface="secondary"
                            onClick={() => setManaging(shareSubjectFromRow(s))}
                          >
                            Manage
                          </Button>
                        ),
                      },
                    ]}
                    data={shownSharing.map((s) => ({
                      ...s,
                      key: `${s.kind}:${s.drive_id}:${s.path}:${s.album_id}`,
                    }))}
                    rowKey="key"
                    mobileCards
                    striped
                    onRowClick={(s) => setManaging(shareSubjectFromRow(s))}
                  />
                </div>
              </Card>
            )
          )}
        </>
      )}

      <ShareSheet
        open={managing != null}
        subject={managing}
        onClose={() => setManaging(null)}
      />

      <ConfirmModal
        open={leaving != null}
        title={leaving ? `Leave ${leaving.name}?` : "Leave this share?"}
        variant="danger-undoable"
        confirmLabel="Leave"
        loading={leave.isPending}
        error={leaveError}
        onClose={() => {
          setLeaving(null);
          setLeaveError(null);
        }}
        onConfirm={() => leaving && leave.mutate(leaving.id)}
      >
        <p className="text-primary text-sm">
          Leave this share? You'll lose the access it gives you — access through other shared folders stays.
        </p>
      </ConfirmModal>
    </Page>
  );
}
