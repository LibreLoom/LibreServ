import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { dashboard as greetingMessages } from "../lib/greetings.jsx";
import SystemHealthPill from "../components/common/SystemHealthPill.jsx";
import SoftwareUpdatePill from "../components/common/SoftwareUpdatePill.jsx";
import TipPill from "../components/common/TipPill.jsx";
import { apiErrorMessage, getDrives, getJson, getRecents, postJson } from "../lib/api.js";
import { KIND_ALBUM } from "../lib/access.js";
import { memberAccessRoots } from "../lib/shareTree.js";
import { PHRASE_QUERY_KEY } from "../lib/cloudPhrase.js";
import { readRecentItems } from "../lib/recentItems.js";
import usePageTitle from "../hooks/usePageTitle.js";
import useReleaseInspectedDrive from "../hooks/useReleaseInspectedDrive.js";
import useNeedsYou from "../hooks/useNeedsYou.js";
import { useSoftwareUpdates } from "../hooks/useSoftwareUpdates.jsx";
import { useSystemHealthCheck } from "../hooks/useSystemHealthCheck.jsx";
import { warningChecks } from "../lib/needsYouChecks.js";
import useBackupRows from "../hooks/useBackupRows.js";
import InspectModal from "../components/files/InspectModal.jsx";
import ProtectSheet from "../components/files/ProtectSheet.jsx";
import RecoveryPhraseCheck from "../components/cloud/RecoveryPhraseCheck.jsx";
import NeedsYou from "../components/dashboard/NeedsYou.jsx";
import RecentsCard from "../components/dashboard/RecentsCard.jsx";
import DriveHomeCard from "../components/dashboard/DriveHomeCard.jsx";
import SharedAlbumsCard from "../components/dashboard/SharedAlbumsCard.jsx";
import BackupsLine from "../components/dashboard/BackupsLine.jsx";
import { isMockUnknownDrive, mockInspectResult, withDevMockDetected } from "../lib/devMockDrives.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

function getGreeting() {
  const today = new Date();
  const month = today.getMonth();
  const date = today.getDate();

  if (month === 0 && date === 1) return "Happy New Year, ";
  if (month === 2 && date === 8) return "Happy International Women's Day, ";
  if (month === 2 && date === 21) return "Happy Nowruz, ";
  if (month === 3 && date === 22) return "Happy Earth Day, ";
  if (month === 4 && date === 1) return "Happy Labour Day, ";
  if (month === 5 && date === 19) return "Happy Juneteenth, ";
  if (month === 9 && date === 31) return "Happy Halloween, ";
  if (month === 10 && date === 1) return "Happy Diwali, ";
  if (month === 11 && date === 25) return "Merry Christmas, ";
  if (month === 11 && date === 26) return "Happy Kwanzaa, ";
  if (month === 6 && date === 4) return "Happy Independence Day, ";

  const hoursSinceEpoch = Math.floor(today.getTime() / 43200000);
  return greetingMessages[hoursSinceEpoch % greetingMessages.length];
}

export default function DashboardPage() {
  const { addToast } = useToast();
  const releaseInspectedDrive = useReleaseInspectedDrive();
  const queryClient = useQueryClient();
  const greeting = useMemo(() => getGreeting(), []);
  usePageTitle("Dashboard");
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { items } = useNeedsYou();
  // The same queries the two header pills read, so nothing is fetched twice. Both stay off for
  // Members. The page reads them to know whether any pill will draw: the header turns an empty
  // right-hand slot into a blank card when it splits on a phone.
  const updates = useSoftwareUpdates();
  const systemHealth = useSystemHealthCheck();
  const { rows, phrase } = useBackupRows();
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const detected = useQuery({
    queryKey: ["drives-detected"],
    queryFn: () => getJson("/api/v1/drives/detected"),
    refetchInterval: 5000,
    enabled: isAdmin,
  });
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: !isAdmin,
  });

  // Drive picker: opened by the "Add drive" button on the New drive plugged in row.
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [inspectFor, setInspectFor] = useState(null);
  // Backup row that opened its protect sheet, and whether the recovery phrase check is open.
  const [sheet, setSheet] = useState(null);
  const [checkingPhrase, setCheckingPhrase] = useState(false);

  const inspect = useMutation({
    mutationFn: (/** @type {any} */ drive) => {
      if (
        isMockUnknownDrive(drive?.name)
        && !detected.data?.some((real) => real.name === drive.name)
      ) {
        return Promise.resolve(mockInspectResult());
      }
      return postJson(`/api/v1/drives/${drive.name}/inspect`, {});
    },
  });

  const adopt = useMutation({
    mutationFn: (/** @type {{ drive: any, label: string, erase?: boolean }} */ { drive, label, erase }) =>
      postJson(`/api/v1/drives/${drive.name}/adopt`, { label, erase: Boolean(erase) }),
    onSuccess: () => {
      addToast({ type: "success", message: "Drive added." });
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
  });

  const adoptError = adopt.isError
    ? apiErrorMessage(adopt.error, "Luna couldn't add this drive. Try again.")
    : null;

  /**
   * Runs the button on a Needs you row that the page (not a link) handles.
   * @param {import("../components/dashboard/NeedsYou.jsx").NeedsYouItem} item
   */
  function handleAction(item) {
    switch (item.action?.intent) {
      case "open-drive-picker":
        inspect.reset();
        adopt.reset();
        setInspectFor(null);
        setDrivePickerOpen(true);
        break;
      case "open-backup":
        setSheet(item.action.payload);
        break;
      case "check-phrase":
        setCheckingPhrase(true);
        break;
      default:
        break;
    }
  }

  function closeCheck() {
    setCheckingPhrase(false);
    queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
  }

  const greetingBase = greeting.endsWith(", ") ? greeting.slice(0, -2) : greeting;
  const showUsername = user?.username;
  const greetingTitle = (
    <span className="inline-flex flex-wrap items-center justify-center gap-2">
      <span>{showUsername ? `${greetingBase},` : greetingBase}</span>
      <span
        className={cn(
          "transition-all duration-300 ease-out motion-reduce:transition-none",
          showUsername ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1",
        )}
        aria-hidden={!showUsername}
      >
        {showUsername ? user.username : ""}
      </span>
    </span>
  );

  const adopted = Array.isArray(drives.data) ? drives.data : [];
  // Dev mock injects a review fixture when lunad reports nothing new.
  const pluggedIn = withDevMockDetected(detected.data);
  // Server-backed recents list: validates existence, follows renames, and omits dead links.
  const recentsQuery = useQuery({
    queryKey: ["recents", user?.username],
    queryFn: getRecents,
    enabled: Boolean(user?.username),
  });
  const recentItems = recentsQuery.data ?? (recentsQuery.isError ? readRecentItems(user?.username) : []);
  const myShares = memberAccessRoots(Array.isArray(access.data) ? access.data : []);
  const grants = myShares.filter((row) => row.kind !== KIND_ALBUM);
  const albumsShared = myShares.filter((row) => row.kind === KIND_ALBUM);
  const memberSharesLoading = !isAdmin && access.isLoading;
  const memberHasNothingShared =
    !isAdmin &&
    !drives.isLoading &&
    !memberSharesLoading &&
    grants.length === 0 &&
    albumsShared.length === 0;

  // What the right-hand column holds. Its heading is always there when the column is: an Admin
  // with no drives gets no column at all (the Needs you "No drives yet" row covers it).
  const hasRecents = recentItems.length > 0;
  const showAlbums = !isAdmin && !memberSharesLoading && albumsShared.length > 0;
  const showNothingShared = !drives.isLoading && memberHasNothingShared;
  const showDrivesColumn =
    adopted.length > 0 || (!isAdmin && grants.length > 0) || showAlbums || showNothingShared;
  // "See all shared items" lives on the first drive card that is ready (the only cards that show
  // it). An unplugged, ejected or failed first drive must not take the link with it; with no
  // ready card at all, the fallback Card below carries the link instead.
  const firstReadyIndex = adopted.findIndex(
    (drive) => drive.state === "as_is" || drive.state === "readonly",
  );
  const memberHasGrants = !isAdmin && grants.length > 0;

  // Mirrors when SoftwareUpdatePill and SystemHealthPill render something. Only a slot that holds a
  // pill is passed to the header; otherwise it gets none.
  const updateReady =
    isAdmin && !updates.isLoading && !updates.error && Boolean(updates.data?.update_available);
  const warningsShown =
    isAdmin &&
    !systemHealth.isLoading &&
    !systemHealth.error &&
    warningChecks(systemHealth.data).length > 0;
  const headerPills =
    updateReady || warningsShown ? (
      <div
        data-slot="header-pills"
        className="flex items-center gap-2 flex-wrap justify-end"
      >
        <SoftwareUpdatePill />
        <SystemHealthPill />
      </div>
    ) : undefined;

  return (
    <Page
      data-slot="dashboard-page"
      title={greetingTitle}
      titleId="dashboard-title"
      padded={false}
      headerClassName="px-8 mb-10"
      headerCardClassName="group"
      leftContent={<TipPill />}
      rightContent={headerPills}
    >
      <div className="flex flex-col gap-8">
        {items.length > 0 && (
          <div className="px-8">
            <NeedsYou items={items} onAction={handleAction} />
          </div>
        )}

        {rows.length > 0 && (
          <div className="px-8">
            <BackupsLine rows={rows} />
          </div>
        )}

        {(hasRecents || showDrivesColumn) && (
          <div
            className={cn(
              "grid grid-cols-1 gap-8 px-8 items-start",
              hasRecents && showDrivesColumn && "md:grid-cols-2",
            )}
          >
            {hasRecents && (
              <div className="min-w-0">
                <RecentsCard items={recentItems} drives={adopted} />
              </div>
            )}

            {showDrivesColumn && (
              <div className="min-w-0 space-y-4">
                <h2 className="font-mono font-normal text-lg">{isAdmin ? "Drives" : "Your folders"}</h2>

                {adopted.length > 0 && (
                  <div className="grid grid-cols-1 gap-6">
                    {adopted.map((drive, index) => (
                      <DriveHomeCard
                        key={drive.id}
                        drive={drive}
                        isAdmin={isAdmin}
                        grants={grants.filter((g) => g.drive_id === drive.id)}
                        showSeeAllShared={memberHasGrants && index === firstReadyIndex}
                      />
                    ))}
                  </div>
                )}

                {/* Shared folders with no ready drive card to hang the link on: never a dead end. */}
                {memberHasGrants && firstReadyIndex === -1 && (
                  <Card>
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/shared">See all shared items</Link>
                    </Button>
                  </Card>
                )}

                {showNothingShared && (
                  <EmptyState
                    icon={HardDrive}
                    title="Nothing shared with you yet"
                    description="Ask an Admin to share a folder, drive, or album with you."
                  />
                )}

                {showAlbums && <SharedAlbumsCard albums={albumsShared} />}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Drive picker — lists unrecognized drives so the user can choose which to set up.
          Unmount when inspect opens so we don't stack two overlays during ModalCard exit. */}
      {inspectFor == null && (
        <ModalCard
          open={drivePickerOpen}
          onClose={() => setDrivePickerOpen(false)}
          title="New drive detected"
        >
          {({ close }) => (
            <>
              <p className="text-primary text-sm mb-4">
                {pluggedIn.length === 1
                  ? "Luna found a drive that hasn't been added yet. Select it to see what's on it before adding."
                  : "Luna found drives that haven't been added yet. Select one to see what's on it before adding."}
              </p>
              <ul className="space-y-3" aria-label="Drives available to add">
                {pluggedIn.map((drive) => {
                  const meta = [
                    drive.size_bytes
                      ? `${(drive.size_bytes / 1_000_000_000).toFixed(0)} GB`
                      : null,
                    drive.usb || drive.removable ? "USB" : null,
                    drive.fs_type ? drive.fs_type.toUpperCase() : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={drive.name}>
                      <button
                        type="button"
                        className={[
                          "group w-full text-left rounded-large-element surface-primary p-4",
                          "border-2 border-transparent",
                          "motion-safe:transition-[color,background-color,border-color]",
                          "hover:bg-secondary hover:text-primary hover:border-primary",
                          "focus-visible:outline-none focus-visible:border-primary",
                        ].join(" ")}
                        onClick={() => {
                          haptic("selection");
                          inspect.reset();
                          adopt.reset();
                          setDrivePickerOpen(false);
                          setInspectFor(drive);
                          inspect.mutate(drive);
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <HardDrive
                            size={18}
                            className="shrink-0 group-hover:text-primary"
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-sm truncate">
                              {drive.model || drive.name}
                            </div>
                            {meta ? (
                              <div className="mt-0.5 text-xs group-hover:text-primary">{meta}</div>
                            ) : null}
                          </div>
                          <span className="shrink-0 text-xs group-hover:text-primary">
                            Tap to review →
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-4">
                <Button variant="outline" onClick={close}>Cancel</Button>
              </div>
            </>
          )}
        </ModalCard>
      )}

      {/* Inspect / adopt wizard — reuses the same component as DrivesPage */}
      <InspectModal
        open={inspectFor != null}
        drive={inspectFor}
        result={inspect.data}
        error={inspect.isError ? "Luna couldn't look at this drive safely. Make sure it's plugged in and try again." : null}
        onClose={() => { releaseInspectedDrive(inspectFor); setInspectFor(null); inspect.reset(); adopt.reset(); }}
        onAdopt={(label, erase) => adopt.mutateAsync({ drive: inspectFor, label, erase })}
        adoptError={adoptError}
        adopting={adopt.isPending}
      />

      {sheet && (
        <ProtectSheet
          driveId={sheet.source_drive}
          path={sheet.source_path}
          onClose={() => setSheet(null)}
        />
      )}
      {checkingPhrase && phrase?.luna_id && (
        <RecoveryPhraseCheck lunaId={phrase.luna_id} onClose={closeCheck} />
      )}
    </Page>
  );
}
