import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Compass,
  File as FileIcon,
  Folder,
  HardDrive,
  Home,
  Image as ImageIcon,
  Link2Off,
  LogIn,
  MoonStar,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Users,
} from "lucide-react";

import { notfound as quips } from "../lib/greetings.jsx";
import { useAuth } from "../context/AuthContext";
import Navbar from "../components/ui/Navbar";
import { getDrives, getJson } from "../lib/api";
import { parentPath, searchResultHref } from "../lib/paths";
import { parseSearchResponse, searchUrl } from "../lib/fileSearch.js";
import { memberSearchHref } from "../lib/shareTree.js";
import {
  bestDistinctMatches,
  guessSearchTerm,
  moonIllumination,
  moonLitPath,
  moonPhase,
  moonPhaseName,
  normalizePathname,
  pickStableQuip,
  scoreKnownPages,
} from "../lib/notFoundHelpers";

import Card from "@libreloom/ui/components/cards/Card.jsx";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import CardButton from "@libreloom/ui/components/ui/CardButton.jsx";
import IconCircle from "@libreloom/ui/components/ui/IconCircle.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/* ======================================================================
   Where people meant to go
   ====================================================================== */

// Mirrors the Navbar. `aliases` are words people type for the same page.
// Home and Sign in are left out: "Where to next" always offers one of them.
const DESTINATIONS = [
  {
    to: "/gallery",
    label: "Photos",
    icon: ImageIcon,
    aliases: ["photos", "photo", "pictures", "pics", "images", "albums", "videos"],
  },
  {
    to: "/drives",
    label: "Files",
    icon: HardDrive,
    aliases: ["files", "file", "folders", "documents", "docs", "drive", "storage", "browse"],
  },
  { to: "/shared", label: "Shared", icon: Share2, aliases: ["share", "shares", "links", "sharing"] },
  {
    to: "/settings/users",
    label: "Users",
    icon: Users,
    adminOnly: true,
    aliases: ["users", "user", "members", "people", "accounts"],
  },
  {
    to: "/settings",
    label: "Settings",
    icon: SlidersHorizontal,
    aliases: ["admin", "preferences", "prefs", "config", "account", "options"],
  },
];

function candidatesFor(user) {
  const isAdmin = user?.role === "admin";
  return DESTINATIONS.filter((dest) => {
    return !dest.adminOnly || isAdmin;
  }).flatMap((dest) => [
    dest,
    ...dest.aliases.map((alias) => ({ ...dest, match: `/${alias}` })),
  ]);
}

const fallbackQuips = [
  "The pigeon checked the map. Then checked it again. This page is not on it.",
];
const SAFE_QUIPS =
  Array.isArray(quips) && quips.length > 0 ? quips : fallbackQuips;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* ======================================================================
   Tonight's moon — the "0" in 404
   ====================================================================== */

const SWEEP_MS = 2400;

/**
 * Tonight's phase. On first paint the moon starts dark (new moon — like the
 * missing page) and waxes through the cycle until it settles on the real
 * phase in the sky right now.
 */
function useSettlingMoon() {
  const target = useMemo(() => moonPhase(new Date()), []);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [phase, setPhase] = useState(reduced ? target : 0);
  const [settled, setSettled] = useState(reduced);

  useEffect(() => {
    if (reduced) return undefined;
    // Always sweep a visible distance, even when tonight is a thin crescent.
    const end = target < 0.3 ? target + 1 : target;
    let frame = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / SWEEP_MS);
      const eased = 1 - (1 - t) ** 4;
      setPhase((end * eased) % 1);
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setPhase(target);
        setSettled(true);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced, target]);

  return { phase, target, settled };
}

function Moon({ phase, className }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {/* The sunlit side is always the light theme color, like a real
          moon: the unlit side is ink on paper in light mode and the night
          sky in dark mode. The accent limb keeps the disc readable at full
          and new moon. */}
      <circle
        cx="50"
        cy="50"
        r="46"
        className="fill-secondary stroke-accent dark:fill-primary"
        strokeWidth="2"
      />
      <path
        d={moonLitPath(phase, 50, 50, 45)}
        className="fill-primary dark:fill-secondary"
      />
    </svg>
  );
}

/** Keep the pill on one line: long paths show only their last part. */
function shortenPath(path, max = 26) {
  if (path.length <= max) return path;
  const last = path.slice(path.lastIndexOf("/") + 1) || path;
  const tail = last.length > max - 2 ? `${last.slice(0, max - 3)}…` : last;
  return `…/${tail}`;
}

function MoonHero({ shownPath }) {
  const { phase, target, settled } = useSettlingMoon();
  const shortPath = shortenPath(shownPath);
  const lit = Math.round(moonIllumination(target) * 100);

  return (
    <section className="flex flex-col items-center py-6 text-secondary sm:py-10">
      <p className="sr-only">Error 404</p>
      <p
        aria-hidden="true"
        className="flex items-center gap-[0.06em] font-mono font-normal leading-none text-[7.5rem] sm:text-[11rem]"
      >
        <span>4</span>
        <Moon phase={phase} className="h-[0.7em] w-[0.7em]" />
        <span>4</span>
      </p>
      <p
        className={cn(
          "mt-5 text-center font-mono text-xs text-secondary",
          "motion-safe:transition-[opacity,transform] motion-safe:duration-700",
          settled ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
        )}
      >
        <span className="block sm:inline">Tonight's moon</span>
        <span className="hidden sm:inline"> · </span>
        <span className="block sm:inline">
          {moonPhaseName(target)} · {lit}% lit
        </span>
      </p>
      {/* Inset chip on a padded track: the chip holds the path, the track
          names the problem. */}
      <p
        title={shownPath === shortPath ? undefined : shownPath}
        className="mt-6 inline-flex max-w-full items-center gap-3 rounded-pill surface-secondary p-1 pr-4"
      >
        <span
          aria-hidden="true"
          className="min-w-0 truncate rounded-pill surface-primary px-3 py-1 font-mono text-sm"
        >
          {shortPath}
        </span>
        <span className="sr-only">{shownPath}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs">
          <Link2Off size={14} aria-hidden="true" />
          Not found
        </span>
      </p>
    </section>
  );
}

/* ======================================================================
   Find the file an old link pointed at
   ====================================================================== */

function locationOf(item, driveLabel) {
  const folder = item.parent != null ? item.parent : parentPath(item.path) ?? "";
  return folder ? `${driveLabel} / ${folder}` : driveLabel;
}

function FindFile({ initialTerm, user, className }) {
  const [typed, setTyped] = useState(initialTerm);
  const [q, setQ] = useState(initialTerm);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const labels = Object.fromEntries(
    (drives.data || []).map((d) => [d.id, d.label]),
  );

  // Members can't always browse a hit's parent folder; route through the
  // same helper the main search uses.
  const isMember = Boolean(user?.role) && user.role !== "admin";
  const memberAccess = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: isMember,
  });

  const results = useQuery({
    queryKey: ["search", q, "all"],
    queryFn: () => getJson(searchUrl(q)),
    enabled: q.length >= 2,
  });

  const hits = parseSearchResponse(results.data).hits.slice(0, 5);
  const searched = q.length >= 2 && results.isSuccess;

  return (
    <Card icon={Search} title="Find a file" className={className}>
      <label className="flex items-center gap-2 rounded-pill border-2 border-transparent surface-primary px-4 py-2 motion-safe:transition-colors focus-within:border-accent">
        <Search size={16} aria-hidden="true" className="shrink-0" />
        <input
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="File or folder name"
          aria-label="Search your files by name"
          autoComplete="off"
          className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-secondary outline-none no-focus-outline"
        />
        {results.isFetching && <Spinner size="sm" />}
      </label>

      <div aria-live="polite">
        {results.isError && (
          <p className="mt-3 text-sm text-primary">
            Luna couldn't search right now. Open Files and browse instead.
          </p>
        )}

        {searched && hits.length === 0 && (
          <p className="mt-3 text-sm text-primary">
            Nothing named “{q}”. Try part of the name.
          </p>
        )}

        {hits.length > 0 && (
          <ul className="mt-3 grid gap-2">
            {hits.map((item, index) => {
              const isDir = item.kind === "dir";
              const Icon = isDir ? Folder : FileIcon;
              const href =
                isMember && memberAccess.data
                  ? memberSearchHref(memberAccess.data, item)
                  : searchResultHref(item);
              return (
                <li
                  key={`${item.drive_id}:${item.path}`}
                  className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:fill-mode-both"
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  <Link
                    to={href}
                    onClick={() => haptic("medium")}
                    className="flex items-center gap-3 rounded-large-element surface-primary px-4 py-2.5 motion-safe:transition-shadow hover:ring-2 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Icon size={18} aria-hidden="true" className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{item.name}</span>
                      <span className="block truncate text-xs text-secondary">
                        {isDir ? "Folder" : "File"} in{" "}
                        {locationOf(item, labels[item.drive_id] || "a drive")}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

/* ======================================================================
   Page
   ====================================================================== */

export default function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  const pathname = normalizePathname(location.pathname);
  const attemptedPath = `${pathname}${location.search ?? ""}${location.hash ?? ""}`;
  const shownPath = useMemo(() => {
    try {
      return decodeURI(attemptedPath);
    } catch {
      return attemptedPath;
    }
  }, [attemptedPath]);

  const quip = useMemo(
    () => pickStableQuip(attemptedPath, SAFE_QUIPS),
    [attemptedPath],
  );

  const suggestions = useMemo(
    () => bestDistinctMatches(scoreKnownPages(pathname, candidatesFor(user))),
    [pathname, user],
  );

  // Offer a file search unless the whole link was one mistyped page name.
  // "/documents/Tax 2024.pdf" suggests Files *and* searches for the file.
  const searchTerm = useMemo(() => {
    const segments = pathname.split("/").filter(Boolean).length;
    if (suggestions.length > 0 && segments < 2) return "";
    return guessSearchTerm(pathname);
  }, [pathname, suggestions.length]);

  // React Router numbers history entries; 0 means we are the first page
  // in this tab, so "Go back" would leave Luna entirely.
  const canGoBack =
    typeof window !== "undefined" && (window.history.state?.idx ?? 0) > 0;

  const signedIn = Boolean(user);
  const signedOut = !loading && !user;

  const showFind = signedIn && Boolean(searchTerm);
  const cardCount = 1 + (showFind ? 1 : 0) + (suggestions.length > 0 ? 1 : 0);
  const grid = cardCount === 1 ? "max-w-md" : "max-w-3xl md:grid-cols-2";

  return (
    <>
      <Page
        title="Page not found"
        leftContent={<IconCircle icon={MoonStar} />}
        headerClassName="mb-2"
      >
        <MoonHero shownPath={shownPath} />

        <div className={cn("mx-auto grid gap-4", grid)}>
          {showFind && (
            <FindFile
              key={searchTerm}
              initialTerm={searchTerm}
              user={user}
              className={cardCount === 3 ? "md:col-span-2" : ""}
            />
          )}

          {suggestions.length > 0 && (
            <Card icon={Sparkles} title="Did you mean">
              <nav aria-label="Did you mean" className="flex flex-col gap-2">
                {suggestions.map(({ to, label, icon }) => (
                  <CardButton
                    key={to}
                    action={to}
                    actionLabel={label}
                    icon={icon}
                    align="start"
                    className="mt-0 px-4 py-2.5"
                  >
                    {label}
                  </CardButton>
                ))}
              </nav>
            </Card>
          )}

          <Card icon={Compass} title="Where to next">
            <p className="mb-4 text-sm text-primary">{quip}</p>
            <div className="flex flex-col gap-2">
              {signedOut ? (
                <CardButton
                  action="/login"
                  actionLabel="Sign in"
                  icon={LogIn}
                  align="start"
                  className="mt-0 px-4 py-2.5"
                >
                  Sign in
                </CardButton>
              ) : (
                <CardButton
                  action="/"
                  actionLabel="Home"
                  icon={Home}
                  align="start"
                  className="mt-0 px-4 py-2.5"
                >
                  Home
                </CardButton>
              )}
              {canGoBack && (
                <CardButton
                  onClick={() => navigate(-1)}
                  actionLabel="Go back"
                  icon={ArrowLeft}
                  align="start"
                  className="mt-0 px-4 py-2.5"
                >
                  Go back
                </CardButton>
              )}
            </div>
          </Card>
        </div>
      </Page>
      {signedIn && <Navbar />}
    </>
  );
}
