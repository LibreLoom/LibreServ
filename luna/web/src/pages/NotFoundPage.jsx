import { useEffect, useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Home, MoonStar } from "lucide-react";

import { notfound as quips } from "../assets/greetings";

import Card from "../components/cards/Card";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import IconCircle from "../components/ui/IconCircle";
import {
  normalizePathname,
  pickStableQuip,
  scoreKnownPages,
} from "../lib/notFoundHelpers";

/* ======================================================================
   Known pages + safe quips
   ====================================================================== */

// Route targets mirror the bottom Navbar labels.
const knownPages = [
  { to: "/drives", label: "Files" },
  { to: "/gallery", label: "Photos" },
  { to: "/settings", label: "Settings" },
  { to: "/settings/users", label: "Users" },
  { to: "/login", label: "Login" },
];

const fallbackQuips = [
  "The pigeon checked the map. Then checked it again. This page is not on it.",
  "The page is missing. The pigeon filed the paperwork immediately.",
  "The pigeon opened this door carefully. There was nothing behind it.",
];

// Resolve once; avoids modulo-by-zero and avoids hook dependency noise.
const SAFE_QUIPS =
  Array.isArray(quips) && quips.length > 0 ? quips : fallbackQuips;

/* ======================================================================
   Flyby scene — a CLOSE flyby. The moon looms off the top-right corner
   and deliberately bleeds out of frame, so no viewport crop can make it
   look accidentally cut. The request's trajectory dives in from the left,
   vanishes behind the lit limb (moon is painted over the path), and
   slingshots out the bottom-right carrying the attempted URL.
   viewBox 800x420, slice-anchored so the sky bleeds to the page edges.
   ====================================================================== */

const MOON = { cx: 640, cy: 60, r: 210 };
// Shadow bite offset up-right (away from the scene): the terminator
// sweeps the visible limb and the lit crescent faces the incoming path.
const MOON_SHADOW = { cx: 710, cy: -10, r: 215 };

const FLYBY_PATH =
  "M -20 170 C 160 165, 300 160, 400 158 " +
  "C 470 156, 540 170, 590 205 " +
  "C 640 240, 690 290, 740 330 " +
  "C 780 360, 820 380, 860 400";

const STARS = [
  { x: 60, y: 40, r: 1.6, opacity: 0.7, delay: "0s" },
  { x: 140, y: 120, r: 1.2, opacity: 0.5, delay: "0.6s" },
  { x: 230, y: 56, r: 1.4, opacity: 0.85, delay: "1.4s" },
  { x: 310, y: 240, r: 1.1, opacity: 0.6, delay: "0.9s" },
  { x: 90, y: 300, r: 1.5, opacity: 0.75, delay: "1.1s" },
  { x: 210, y: 350, r: 1.2, opacity: 0.5, delay: "2.2s" },
  { x: 385, y: 60, r: 1.6, opacity: 0.8, delay: "0.8s" },
  { x: 425, y: 330, r: 1.3, opacity: 0.6, delay: "1.7s" },
  { x: 505, y: 270, r: 1.1, opacity: 0.5, delay: "0.4s" },
  { x: 762, y: 380, r: 1.5, opacity: 0.7, delay: "2.0s" },
  { x: 640, y: 370, r: 1.3, opacity: 0.55, delay: "1.3s" },
  { x: 66, y: 190, r: 1.4, opacity: 0.7, delay: "0.2s" },
  { x: 340, y: 140, r: 1.2, opacity: 0.55, delay: "1.9s" },
  { x: 190, y: 240, r: 1.1, opacity: 0.6, delay: "1.0s" },
  { x: 455, y: 390, r: 1.1, opacity: 0.5, delay: "2.5s" },
];

const SECONDARY = "var(--color-secondary)";
const PRIMARY = "var(--color-primary)";
const MONO = "FreeMono, Courier New, monospace";

function FlybyScene({ attemptedPath }) {
  return (
    <section
      aria-hidden="true"
      className="relative h-[68vh] min-h-96 select-none overflow-hidden"
    >
      <svg
        viewBox="0 0 800 420"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
      >
        {STARS.map((star, index) => (
          <circle
            key={index}
            cx={star.x}
            cy={star.y}
            r={star.r}
            fill={SECONDARY}
            opacity={star.opacity}
            className="animate-luna-twinkle"
            style={{ animationDelay: star.delay }}
          />
        ))}

        {/* Range rings around the moon — star-chart furniture */}
        <circle cx={MOON.cx} cy={MOON.cy} r="280" fill="none" stroke={SECONDARY} strokeWidth="1" opacity="0.06" />
        <circle cx={MOON.cx} cy={MOON.cy} r="350" fill="none" stroke={SECONDARY} strokeWidth="1" opacity="0.04" />

        {/* The request's plotted course — drawn in once on load */}
        <path
          id="luna-flyby-path"
          d={FLYBY_PATH}
          pathLength="1000"
          fill="none"
          stroke={SECONDARY}
          strokeWidth="1.5"
          opacity="0.9"
          className="animate-luna-trajectory"
        />

        {/* The request itself, looping the flyby forever, with a faint tail */}
        <g className="luna-flyby-dot">
          <circle r="9" fill={SECONDARY} opacity="0.15">
            <animateMotion dur="9s" repeatCount="indefinite" path={FLYBY_PATH} />
          </circle>
          <circle r="5" fill={SECONDARY}>
            <animateMotion dur="9s" repeatCount="indefinite" path={FLYBY_PATH} />
          </circle>
          <circle r="3" fill={SECONDARY} opacity="0.5">
            <animateMotion
              dur="9s"
              begin="-0.14s"
              repeatCount="indefinite"
              path={FLYBY_PATH}
            />
          </circle>
          <circle r="2" fill={SECONDARY} opacity="0.3">
            <animateMotion
              dur="9s"
              begin="-0.28s"
              repeatCount="indefinite"
              path={FLYBY_PATH}
            />
          </circle>
        </g>
        {/* Reduced-motion stand-in: a static marker at the exit point */}
        <circle
          className="luna-flyby-static"
          cx="836"
          cy="391"
          r="5"
          fill={SECONDARY}
        />

        {/* The attempted URL rides the escape leg out of the system */}
        <text
          fontSize="13"
          fontFamily={MONO}
          letterSpacing="1"
          fill={SECONDARY}
          opacity="0.85"
        >
          <textPath href="#luna-flyby-path" startOffset="66%" dy="-10">
            {attemptedPath}
          </textPath>
        </text>

        {/* The moon — a huge limb bleeding off the top-right corner, drawn
            over the path so the trajectory vanishes behind it mid-flight */}
        <defs>
          <clipPath id="luna-moon-clip">
            <circle cx={MOON.cx} cy={MOON.cy} r={MOON.r} />
          </clipPath>
        </defs>
        <circle cx={MOON.cx} cy={MOON.cy} r="228" fill={SECONDARY} opacity="0.06" />
        <circle cx={MOON.cx} cy={MOON.cy} r={MOON.r} fill={SECONDARY} />
        <g clipPath="url(#luna-moon-clip)">
          <circle cx={MOON_SHADOW.cx} cy={MOON_SHADOW.cy} r={MOON_SHADOW.r} fill={PRIMARY} />
          <circle cx="470" cy="160" r="13" fill={PRIMARY} opacity="0.12" />
          <circle cx="505" cy="125" r="8" fill={PRIMARY} opacity="0.12" />
          <circle cx="490" cy="185" r="6" fill={PRIMARY} opacity="0.12" />
          <circle cx="520" cy="140" r="10" fill={PRIMARY} opacity="0.12" />
        </g>
      </svg>

      {/* Mission readout — HTML overlay so the slice crop can never cut it */}
      <div className="absolute left-8 top-6 font-mono">
        <p className="text-xs tracking-[0.3em] text-secondary">FLYBY · MISS</p>
        <p className="mt-2 text-xs text-secondary">
          no page at these coordinates
        </p>
      </div>

      {/* Ghosted error code, huge and quiet behind everything */}
      <p className="absolute bottom-2 left-6 font-mono text-[11rem] leading-none text-secondary opacity-[0.07] sm:text-[14rem]">
        404
      </p>
    </section>
  );
}

/* ======================================================================
   Component
   ====================================================================== */

export default function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const pathname = normalizePathname(location.pathname);
  const search = String(location.search ?? "");
  const hash = String(location.hash ?? "");
  const attemptedPath = `${pathname}${search}${hash}`;

  const quip = useMemo(
    () => pickStableQuip(attemptedPath, SAFE_QUIPS),
    [attemptedPath],
  );

  // Score known routes for "close enough" suggestions (best match first).
  const suggestedPages = useMemo(() => {
    const closeMatches = scoreKnownPages(pathname, knownPages).filter(
      (match) => match.isClose,
    );
    if (closeMatches.length === 0) return [];

    const bestScore = closeMatches[0].score;
    return closeMatches
      .filter((match) => match.score === bestScore)
      .slice(0, 2);
  }, [pathname]);

  // Move focus to the page region so keyboard/screen-reader users land here.
  useEffect(() => {
    const main = document.getElementById("main-content");
    if (main && typeof main.focus === "function") main.focus();
  }, [attemptedPath]);

  function handleGoBack() {
    // If there's history, go back. Otherwise, go home.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/", { replace: true });
    }
  }

  return (
    <Page
      title="Page not found"
      leftContent={<IconCircle icon={MoonStar} />}
      padded={false}
    >
      <FlybyScene attemptedPath={attemptedPath} />

      <div className="px-8">
        <Card className="relative z-10 mx-auto -mt-24 max-w-xl">
          <div className="flex flex-col items-center gap-5 text-center">
            <div>
              <p className="font-mono text-xs font-normal uppercase tracking-widest text-primary">
                Error 404
              </p>
              <p className="mt-2 max-w-prose text-primary">{quip}</p>
            </div>

            <div className="w-full">
              <p className="text-sm text-primary">You tried to visit</p>
              <code className="mt-2 block w-full overflow-x-auto rounded-large-element bg-primary/10 p-4 font-mono text-sm text-primary">
                {attemptedPath || "/"}
              </code>
            </div>

            {suggestedPages.length > 0 && (
              <div className="w-full rounded-large-element bg-primary/10 p-5">
                <p className="font-mono font-normal text-primary">
                  Did you mean…
                </p>
                <ul className="mt-3 flex flex-wrap justify-center gap-3">
                  {suggestedPages.map((page) => (
                    <li key={page.to}>
                      <Button asChild variant="primary">
                        <Link to={page.to}>{page.label}</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-3">
              <Button variant="outline" surface="secondary" onClick={handleGoBack}>
                <ArrowLeft size={16} aria-hidden="true" />
                Go back
              </Button>
              <Button asChild variant="primary">
                <Link to="/">
                  <Home size={16} aria-hidden="true" />
                  Home
                </Link>
              </Button>
            </div>

            <p className="text-sm text-primary">
              If a link brought you here, it may be old or mistyped.
            </p>
          </div>
        </Card>
      </div>
    </Page>
  );
}
