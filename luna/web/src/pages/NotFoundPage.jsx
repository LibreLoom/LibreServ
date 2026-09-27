import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  File as FileIcon,
  Folder,
  HardDrive,
  Home,
  Image as ImageIcon,
  LogIn,
  MoonStar,
  Search,
  Share2,
  SlidersHorizontal,
  Users,
} from "lucide-react";

import { notfound as quips } from "../assets/greetings";
import { useAuth } from "../context/AuthContext";
import Navbar from "../components/ui/Navbar";
import { getDrives, getJson } from "../lib/api";
import { parentPath, searchResultHref } from "../lib/paths";
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
import Button from "@libreloom/ui/components/ui/Button.jsx";
import IconCircle from "@libreloom/ui/components/ui/IconCircle.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/* ======================================================================
   Where people meant to go
   ====================================================================== */

// Mirrors the Navbar. `aliases` are words people type for the same page.
const DESTINATIONS = [
  { to: "/", label: "Home", icon: Home, aliases: ["home", "dashboard", "start", "index"] },
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
  { to: "/login", label: "Sign in", icon: LogIn, signedOutOnly: true, aliases: ["signin", "sign-in", "logon"] },
];

function candidatesFor(user) {
  const isAdmin = user?.role === "admin";
  return DESTINATIONS.filter((dest) => {
    if (dest.adminOnly && !isAdmin) return false;
    if (dest.signedOutOnly && user) return false;
    return true;
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

function MoonHero() {
  const { phase, target, settled } = useSettlingMoon();
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
          "mt-5 text-center font-mono text-xs uppercase tracking-[0.2em] text-secondary",
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

function FindFile({ initialTerm, user }) {
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
    queryKey: ["search", q],
    queryFn: () => getJson(`/api/v1/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });

  const hits = (results.data || []).slice(0, 5);
  const searched = q.length >= 2 && results.isSuccess;

  return (
    <div className="w-full text-left">
      <h2 className="font-mono font-normal text-primary">Looking for a file?</h2>
      <p className="mt-1 text-sm text-primary">
        Links stop working when a file is moved or renamed. Luna can look for
        it by name.
      </p>

      <label className="mt-3 flex items-center gap-2 rounded-pill border-2 border-transparent bg-primary px-4 py-2 text-secondary motion-safe:transition-colors focus-within:border-accent">
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
            Nothing named “{q}”. Try a shorter part of the name.
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
                    className="flex items-center gap-3 rounded-large-element bg-primary px-4 py-2.5 text-secondary motion-safe:transition-shadow hover:ring-2 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent"
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
    </div>
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

  return (
    <>
      <Page
        title="Page not found"
        leftContent={<IconCircle icon={MoonStar} />}
        headerClassName="mb-2"
      >
        <MoonHero />

        <Card className="mx-auto max-w-xl">
          <div className="flex flex-col items-center gap-5 text-center">
            <p className="max-w-prose text-primary">{quip}</p>

            <div className="flex max-w-full flex-col items-center gap-2">
              <p className="text-sm text-primary">There's no page at</p>
              <code className="max-w-full overflow-x-auto whitespace-nowrap rounded-pill bg-primary px-4 py-1.5 font-mono text-sm text-secondary">
                {shownPath}
              </code>
              <p className="text-sm text-primary">
                If a link brought you here, it may be old or mistyped.
              </p>
            </div>

            {suggestions.length > 0 && (
              <nav
                aria-label="Did you mean"
                className="flex flex-wrap items-center justify-center gap-2"
              >
                <span className="font-mono text-primary">Did you mean</span>
                {suggestions.map(({ to, label, icon: Icon }) => (
                  <Button key={to} asChild variant="primary">
                    <Link to={to}>
                      <Icon size={16} aria-hidden="true" />
                      {label}
                    </Link>
                  </Button>
                ))}
              </nav>
            )}

            {signedIn && searchTerm && (
              <FindFile key={searchTerm} initialTerm={searchTerm} user={user} />
            )}

            <div className="flex flex-wrap justify-center gap-3">
              {canGoBack && (
                <Button
                  variant="outline"
                  surface="secondary"
                  onClick={() => navigate(-1)}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  Go back
                </Button>
              )}
              {signedOut ? (
                <Button asChild variant="primary">
                  <Link to="/login">
                    <LogIn size={16} aria-hidden="true" />
                    Sign in
                  </Link>
                </Button>
              ) : (
                <Button asChild variant="primary">
                  <Link to="/">
                    <Home size={16} aria-hidden="true" />
                    Home
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </Card>
      </Page>
      {signedIn && <Navbar />}
    </>
  );
}
