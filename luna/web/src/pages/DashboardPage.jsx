import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, History } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { dashboard as greetingMessages } from "../lib/greetings.jsx";
import SystemHealthPill from "../components/common/SystemHealthPill.jsx";
import SoftwareUpdatePill from "../components/common/SoftwareUpdatePill.jsx";
import TipPill from "../components/common/TipPill.jsx";
import { KIND_ALBUM } from "../lib/access.js";
import { memberAccessRoots } from "../lib/shareTree.js";
import { checkPhraseWords, PHRASE_CHECKED_TOAST, PHRASE_QUERY_KEY } from "../lib/cloudPhrase.js";
import { readRecentItems } from "../lib/recentItems.js";
import { perfAppReady } from "../lib/perf.js";
import { drivesQuery, myAccessQuery, recentsQuery } from "../lib/dashboardData.js";
import usePageTitle from "../hooks/usePageTitle.js";
import useNeedsYou from "../hooks/useNeedsYou.js";
import { detectedDrivesQueryOptions } from "../hooks/detectedDrives.js";
import { useSoftwareUpdates } from "../hooks/useSoftwareUpdates.jsx";
import { useSystemHealthCheck } from "../hooks/useSystemHealthCheck.jsx";
import { pillChecks } from "../lib/needsYouChecks.js";
import useBackupRows from "../hooks/useBackupRows.js";
import ProtectSheet from "../components/files/ProtectSheet.jsx";
import RecoveryPhraseCheck from "../components/cloud/RecoveryPhraseCheck.jsx";
import NeedsYou from "../components/dashboard/NeedsYou.jsx";
import RecentsCard from "../components/dashboard/RecentsCard.jsx";
import DriveHomeCard from "../components/dashboard/DriveHomeCard.jsx";
import NewDriveCard from "../components/dashboard/NewDriveCard.jsx";
import SharedAlbumsCard from "../components/dashboard/SharedAlbumsCard.jsx";
import BackupsLine from "../components/dashboard/BackupsLine.jsx";
import { withDevMockDetected } from "../lib/devMockDrives.js";

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

const NO_GRANTS = [];

/** Placeholder rows with the same shape and height as the real Recents card. */
function RecentsSkeleton() {
  return (
    <Card icon={History} title="Recents" noHeightAnim>
      <ul className="space-y-3 animate-pulse motion-reduce:animate-none" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="rounded-large-element surface-primary p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 h-6 w-6 shrink-0 rounded-large-element surface-secondary" />
                <div className="space-y-2 py-0.5">
                  <div className="h-4 w-40 rounded-pill surface-secondary" />
                  <div className="h-3 w-24 rounded-pill surface-secondary" />
                </div>
              </div>
              <div className="h-3 w-10 rounded-pill surface-secondary" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Holds the drive column's place while its list is still loading. */
function DrivesSkeleton() {
  return (
    <div
      className="h-64 rounded-large-element surface-secondary p-5 animate-pulse motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { addToast } = useToast();
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
  const drives = useQuery(drivesQuery);
  const detected = useQuery(detectedDrivesQueryOptions(isAdmin));
  const access = useQuery(myAccessQuery(!isAdmin));

  // Backup row that opened its protect sheet, and whether the recovery phrase check is open.
  const [sheet, setSheet] = useState(null);
  const [checkingPhrase, setCheckingPhrase] = useState(false);

  /**
   * Runs the button on a Needs you row that the page (not a link) handles.
   * @param {import("../components/dashboard/NeedsYou.jsx").NeedsYouItem} item
   */
  function handleAction(item) {
    switch (item.action?.intent) {
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
  const recents = useQuery(recentsQuery(user?.username));
  const recentItems = recents.data ?? (recents.isError ? readRecentItems(user?.username) : []);
  const myShares = useMemo(
    () => memberAccessRoots(Array.isArray(access.data) ? access.data : []),
    [access.data],
  );
  const grants = useMemo(() => myShares.filter((row) => row.kind !== KIND_ALBUM), [myShares]);
  const albumsShared = useMemo(() => myShares.filter((row) => row.kind === KIND_ALBUM), [myShares]);
  // Grouped once, so a drive's card gets the same array until its grants change
  // and stays memoized instead of re-rendering with every poll on the page.
  const grantsByDrive = useMemo(() => {
    const byDrive = new Map();
    for (const g of grants) byDrive.set(g.drive_id, [...(byDrive.get(g.drive_id) ?? []), g]);
    return byDrive;
  }, [grants]);
  const memberSharesLoading = !isAdmin && access.isLoading;
  const drivesLoading = drives.isLoading || memberSharesLoading;
  // W1/W2/W3 (luna/perf): the Dashboard is usable once its drives, files and
  // recents have answered (or failed).
  const dashboardSettled = !drives.isLoading && !recents.isLoading && !memberSharesLoading;
  useEffect(() => {
    if (dashboardSettled) perfAppReady();
  }, [dashboardSettled]);
  const memberHasNothingShared =
    !isAdmin &&
    !drives.isLoading &&
    !drives.isError &&
    !memberSharesLoading &&
    grants.length === 0 &&
    albumsShared.length === 0;

  // The recents column is always there: rows once loaded, a friendly empty state once settled,
  // and a placeholder while the list is still loading. An empty card stays in one column.
  const hasRecents = recentItems.length > 0;
  const showAlbums = !isAdmin && !memberSharesLoading && albumsShared.length > 0;
  const showNothingShared = !drives.isLoading && !drives.isError && memberHasNothingShared;
  // A failed drive list is not an empty one: say so and offer a retry.
  const drivesFailed = drives.isError && adopted.length === 0;
  const showDrivesColumn =
    drivesFailed ||
    adopted.length > 0 ||
    (isAdmin && pluggedIn.length > 0) ||
    (!isAdmin && grants.length > 0) ||
    showAlbums ||
    showNothingShared;
  // Hold the drives column's place with a skeleton while its lists answer.
  const showDrives = drivesLoading || showDrivesColumn;
  // Two columns only when both really hold content (or both are still loading),
  // so an empty recents card never claims half the page.
  const twoColumns = (hasRecents && showDrivesColumn) || (recents.isLoading && drivesLoading);
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
  const pillShown =
    isAdmin &&
    !systemHealth.isLoading &&
    !systemHealth.error &&
    pillChecks(systemHealth.data).length > 0;
  const headerPills =
    updateReady || pillShown ? (
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

        <div
          className={cn(
            "grid grid-cols-1 gap-8 px-8 items-start",
            twoColumns && "md:grid-cols-2",
          )}
        >
          <div className="min-w-0">
            {recents.isLoading ? (
              <RecentsSkeleton />
            ) : (
              <RecentsCard items={recentItems} drives={adopted} />
            )}
          </div>

          {showDrives && (
            <div className="min-w-0 space-y-4">
              <h2 className="font-mono font-normal text-lg">{isAdmin ? "Drives" : "Your files"}</h2>
              {drivesLoading ? (
                <DrivesSkeleton />
              ) : (
                <>
                  {drivesFailed && (
                    <PageNotice variant="error" role="alert">
                      <div className="space-y-3">
                        <p>
                          {isAdmin ? "Luna couldn't load your drives." : "Luna couldn't load your files."}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          surface="primary"
                          loading={drives.isFetching}
                          onClick={() => drives.refetch()}
                        >
                          Try again
                        </Button>
                      </div>
                    </PageNotice>
                  )}

                  {adopted.length > 0 && (
                    <div className="grid grid-cols-1 gap-6">
                      {adopted.map((drive, index) => (
                        <DriveHomeCard
                          key={drive.id}
                          drive={drive}
                          isAdmin={isAdmin}
                          grants={grantsByDrive.get(drive.id) ?? NO_GRANTS}
                          showSeeAllShared={memberHasGrants && index === firstReadyIndex}
                        />
                      ))}
                    </div>
                  )}

                  {isAdmin && <NewDriveCard drives={pluggedIn} />}

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
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {sheet && (
        <ProtectSheet
          driveId={sheet.source_drive}
          path={sheet.source_path}
          onClose={() => setSheet(null)}
        />
      )}
      {checkingPhrase && phrase?.luna_id && (
        <RecoveryPhraseCheck
          verify={(words) => checkPhraseWords(words, phrase.luna_id).then(Boolean)}
          words={phrase.phrase_words}
          onVerified={() => {
            addToast(PHRASE_CHECKED_TOAST);
            closeCheck();
          }}
          onLost={() => navigate("/settings#cloud_backup")}
          onClose={closeCheck}
        />
      )}
    </Page>
  );
}
