/* eslint-disable react-refresh/only-export-components -- lightbox exports URL helpers used by gallery pages and tests */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Heart,
  Images,
  Info,
  Link2,
  Play,
  Trash2,
  X,
} from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import LightboxMedia from "./LightboxMedia.jsx";
import PhotoInfoPanel from "./PhotoInfoPanel.jsx";
import { contentHref, downloadHref, folderHref } from "../../lib/paths.js";
import { isHeicFile } from "../../lib/fileKinds.js";
import { Link } from "react-router-dom";
import { lockBodyScroll } from "../../utils/bodyScrollLock.js";
import { photoSelectionKey } from "../../hooks/useMultiSelect.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { cn } from "@libreloom/ui/lib/utils.js";

/** Match `fullscreen-overlay-out` / `file-viewer-out` duration in index.css. */
const FULLSCREEN_EXIT_MS = 250;
/** Breathing room between panes so neighbors peek in like a carousel. */
const PANE_GAP_PX = 12;
/**
 * Critically-damped spring for settles (px/s², px/s). Damping ratio = 1 →
 * lands exactly on target with zero overshoot; release velocity carries in.
 */
const SPRING_STIFFNESS = 220;
const SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS);
const SETTLE_EPS_PX = 0.5;
const SETTLE_EPS_VEL = 15; // px/s
const SETTLE_TIMEOUT_MS = 1200;
/** Momentum projection (ms) — a swipe commits where the fling would land. */
const FLING_PROJECT_MS = 160;
/** Release velocity (px/ms) that commits a flick even from a short drag. */
const FLICK_VEL_PX_MS = 0.35;
/** Velocity push (pane-widths/s) each button/keyboard commit adds — rapid
 *  clicks accumulate momentum, so "click fast" really does go faster. */
const NAV_IMPULSE_STEPS_S = 1.6;
/** How long the committed destination must sit still before its pane (and its
 *  neighbors) mounts full-res media — chained navigation keeps this moving so
 *  skipped photos only ever fetch their thumbnails. */
const PRIME_DELAY_MS = 320;
/** Minimum px before a touch gesture picks a horizontal/vertical axis. */
const AXIS_LOCK_PX = 8;
/** Rubber-band tension when dragging past the first/last photo. */
const RUBBER_BAND_C = 0.55;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Full-screen gallery lightbox layer. Modals opened from it must stack higher. */
export const LIGHTBOX_Z_CLASS = "z-[80]";
/** Use on ModalCard `overlayClassName` when the dialog opens over PhotoLightbox. */
export const ABOVE_LIGHTBOX_OVERLAY_CLASS = "z-[90]";



/**
 * Prefer gallery preview for HEIC when available; otherwise drive content URL.
 * @param {object} photo
 * @param {{ contentSrc?: string }} [opts]
 */
export function resolveDisplaySrc(photo, opts = {}) {
  if (opts.contentSrc) return opts.contentSrc;
  if (photo?.content) return photo.content;
  if (isHeicFile(photo?.name) && photo?.drive_id && photo?.path) {
    // TODO: backend `/api/v1/gallery/preview` may still be landing — fall back to content if 404.
    return `/api/v1/gallery/preview?drive_id=${encodeURIComponent(photo.drive_id)}&path=${encodeURIComponent(photo.path)}`;
  }
  if (photo?.drive_id && photo?.path) return contentHref(photo.drive_id, photo.path);
  return photo?.thumb || "";
}

/**
 * @param {object} photo
 * @param {{ downloadSrc?: string }} [opts]
 */
export function resolveDownloadSrc(photo, opts = {}) {
  if (opts.downloadSrc) return opts.downloadSrc;
  if (photo?.download) return photo.download;
  if (photo?.drive_id && photo?.path) return downloadHref(photo.drive_id, photo.path);
  return photo?.thumb || "";
}

/**
 * Immersive full-screen photo/video viewer.
 *
 * @param {{
 *   photos: object[],
 *   index?: number,
 *   photoKey?: string,
 *   mode?: "owner"|"guest",
 *   contentSrc?: string,
 *   downloadSrc?: string,
 *   srcFor?: (photo: object) => string,
 *   open?: boolean,
 *   onClose: () => void,
 *   onIndexChange: (index: number) => void,
 *   onFavorite?: (photo: object) => void,
 *   onShare?: (photo: object) => void,
 *   onAlbum?: (photo: object) => void,
 *   onTrash?: (photo: object) => void,
 *   onSetCover?: (photo: object) => void,
 *   slideshow?: boolean,
 *   onSlideshowChange?: (on: boolean) => void,
 *   favoriting?: boolean,
 * }} props
 */
export default function PhotoLightbox({
  photos,
  index: indexProp,
  photoKey,
  mode = "owner",
  contentSrc,
  downloadSrc,
  srcFor = resolveDisplaySrc,
  open = true,
  onClose,
  onIndexChange,
  onFavorite,
  onShare,
  onAlbum,
  onTrash,
  onSetCover,
  slideshow = false,
  onSlideshowChange,
  favoriting,
}) {
  const resolvedIndex = useMemo(() => {
    if (photoKey) {
      const found = photos.findIndex((p) => photoSelectionKey(p) === photoKey);
      if (found >= 0) return found;
    }
    return typeof indexProp === "number" ? indexProp : 0;
  }, [photoKey, photos, indexProp]);

  const index = Math.max(0, Math.min(resolvedIndex, Math.max(photos.length - 1, 0)));
  const photo = photos[index];
  const [isClosing, setIsClosing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // Carousel layout anchor: the index the panes render around. It lags the
  // `index` prop while a spring settle plays so the outgoing photo keeps its
  // pane. During drags/settles the track transform is written straight to the
  // DOM — React only owns the resting position.
  const [layoutIndex, setLayoutIndex] = useState(index);
  // Extra panes a live drag has pulled into view — the window grows under the
  // finger so a long pull travels across many photos without hitting a wall.
  const [reach, setReach] = useState(/** @type {{first:number,last:number}|null} */ (null));
  const guest = mode === "guest";
  const isClosingRef = useRef(false);
  const exitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const stageRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const trackElRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const gestureRef = useRef(/** @type {{x0:number,y0:number,lastX:number,lastT:number,vel:number,axis:(string|null),grab:number,near:number}|null} */ (null));
  // Set when a real swipe ends so the synthetic click that follows touchend
  // (React attaches touch listeners passively — preventDefault won't reach it)
  // is swallowed instead of firing a second navigation under the fingertip.
  const suppressClickRef = useRef(false);
  const settleRef = useRef(/** @type {{dest:number,x:number,v:number,raf:(number|null),timer:(ReturnType<typeof setTimeout>|null)}|null} */ (null));
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  const live = useRef({ layoutIndex, index, photosLength: photos.length });
  live.current = { layoutIndex, index, photosLength: photos.length };
  // The destination the user has committed to — leads `layoutIndex` (which only
  // re-anchors when a settle lands) and may lead the `index` prop by a frame.
  // Chained swipes/clicks stack onto this, so rapid repeats keep advancing.
  // State (not just a ref) so the pane window re-renders to cover it even when
  // the commit came from our own emit rather than a prop change.
  const [pendingIdx, setPendingIdx] = useState(index);
  const pendingRef = useRef(index);
  const setPending = useCallback((v) => {
    pendingRef.current = v;
    setPendingIdx(v);
  }, []);
  // Last destination we emitted — lets the sync effect tell our own late emit
  // apart from an independent parent navigation.
  const lastEmittedRef = useRef(/** @type {number|null} */ (null));
  // The pane range React last committed — panes only exist inside it.
  const windowRef = useRef(/** @type {{first:number,last:number}|null} */ (null));

  const layout = Math.max(0, Math.min(layoutIndex, Math.max(photos.length - 1, 0)));
  // The mounted window covers the anchor, the committed destination, and any
  // pane a live drag is reaching for — a chained swipe or a long pull always
  // finds its next pane already mounted.
  const pending = Math.max(0, Math.min(pendingIdx, Math.max(photos.length - 1, 0)));
  const covFirst = Math.min(layout, pending) - 1;
  const covLast = Math.max(layout, pending) + 1;
  const firstPane = Math.max(0, Math.min(covFirst, reach?.first ?? covFirst));
  const lastPane = Math.min(photos.length - 1, Math.max(covLast, reach?.last ?? covLast));

  const requestClose = useCallback(() => {
    if (isClosingRef.current) return;
    haptic("light");
    isClosingRef.current = true;
    setIsClosing(true);
    const delay = prefersReducedMotion() ? 0 : FULLSCREEN_EXIT_MS;
    if (delay === 0) {
      onCloseRef.current?.();
      return;
    }
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      onCloseRef.current?.();
    }, delay);
  }, []);

  useEffect(() => {
    if (!open && !isClosingRef.current) {
      requestClose();
    }
  }, [open, requestClose]);

  useEffect(() => () => {
    if (exitTimerRef.current != null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (settleRef.current) {
      if (settleRef.current.raf != null) cancelAnimationFrame(settleRef.current.raf);
      if (settleRef.current.timer != null) clearTimeout(settleRef.current.timer);
      settleRef.current = null;
    }
  }, []);

  useEffect(() => lockBodyScroll(), []);



  useEffect(() => {
    if (!slideshow || isClosing || photos.length < 2) return undefined;
    const id = setInterval(() => {
      onIndexChange(index >= photos.length - 1 ? 0 : index + 1);
    }, 4000);
    return () => clearInterval(id);
  }, [slideshow, isClosing, index, photos.length, onIndexChange]);

  /** Width of one pane + gap — the distance of a full slide step. */
  const slideStep = useCallback(() => {
    const w = trackElRef.current?.clientWidth || stageRef.current?.clientWidth || window.innerWidth;
    return (w || 1) + PANE_GAP_PX;
  }, []);

  /** Track translate (px) that centers pane `i` within the mounted window. */
  const paneX = useCallback(
    (i) => -(i - (windowRef.current?.first ?? 0)) * slideStep(),
    [slideStep],
  );

  /** Write the track transform straight to the DOM — no React render. */
  const writeTrack = useCallback((txPx) => {
    const el = trackElRef.current;
    if (el) el.style.transform = `translateX(${txPx}px)`;
  }, []);

  /** Current track translate in px — covers drags and mid-spring grabs. */
  const measureTrack = useCallback(() => {
    const el = trackElRef.current;
    if (!el) return 0;
    try {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      if (Number.isFinite(m.e)) return m.e;
    } catch {
      // jsdom has no DOMMatrix — fall through to the inline-style parse.
    }
    const match = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(el.style.transform || "");
    return match ? Number.parseFloat(match[1]) : 0;
  }, []);

  /** Diminishing-returns drag past the first/last photo — soft, not stiff. */
  function rubberBand(dx, dim) {
    const d = Math.abs(dx);
    return Math.sign(dx) * ((dim * RUBBER_BAND_C * d) / (dim + RUBBER_BAND_C * d));
  }

  // Defined via refs so the spring loop and touch handlers always see fresh state.
  const syncTrackRef = useRef(/** @type {((fromLayout?: number) => void)|null} */ (null));

  const finishSettle = useCallback(() => {
    const s = settleRef.current;
    if (!s) return;
    settleRef.current = null;
    if (s.raf != null) cancelAnimationFrame(s.raf);
    if (s.timer != null) clearTimeout(s.timer);
    // Pin the exact landing spot in the CURRENT window, then re-anchor. React
    // commits the shifted pane window and the layout effect re-pins under the
    // new anchor in the same frame — the photo under your finger never moves.
    writeTrack(paneX(s.dest));
    setLayoutIndex(s.dest);
    syncTrackRef.current?.(s.dest);
  }, [paneX, writeTrack]);

  /**
   * Critically-damped spring from the track's live position to `dest`'s pane.
   * The fling's velocity (px/ms) feeds straight in — the photo keeps the
   * momentum your finger gave it, then lands dead-center with no overshoot.
   * The target is re-evaluated per frame so a shifting pane window re-aims the
   * spring instead of jumping.
   */
  const settleTo = useCallback(
    (dest, velocity = 0) => {
      if (settleRef.current) {
        if (settleRef.current.raf != null) cancelAnimationFrame(settleRef.current.raf);
        if (settleRef.current.timer != null) clearTimeout(settleRef.current.timer);
        settleRef.current = null;
      }
      const el = trackElRef.current;
      const s = {
        dest,
        x: measureTrack(),
        v: velocity * 1000, // px/s
        raf: /** @type {number|null} */ (0),
        timer: /** @type {ReturnType<typeof setTimeout>|null} */ (null),
      };
      if (
        !el ||
        prefersReducedMotion() ||
        (Math.abs(s.x - paneX(dest)) < SETTLE_EPS_PX && Math.abs(s.v) < SETTLE_EPS_VEL)
      ) {
        writeTrack(paneX(dest));
        settleRef.current = { dest, x: paneX(dest), v: 0, raf: null, timer: null };
        finishSettle();
        return;
      }
      s.timer = setTimeout(finishSettle, SETTLE_TIMEOUT_MS);
      let last = performance.now();
      const tick = (now) => {
        if (settleRef.current !== s) return;
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        const target = paneX(s.dest);
        const prev = s.x - target;
        const a = -SPRING_STIFFNESS * prev - SPRING_DAMPING * s.v;
        s.v += a * dt;
        s.x += s.v * dt;
        // Hard no-overshoot guard: pin the moment the spring crosses target.
        if (prev !== 0 && Math.sign(s.x - target) !== Math.sign(prev)) {
          writeTrack(target);
          finishSettle();
          return;
        }
        writeTrack(s.x);
        if (Math.abs(s.x - target) < SETTLE_EPS_PX && Math.abs(s.v) < SETTLE_EPS_VEL) {
          finishSettle();
          return;
        }
        s.raf = requestAnimationFrame(tick);
      };
      settleRef.current = s;
      s.raf = requestAnimationFrame(tick);
    },
    [finishSettle, measureTrack, paneX, writeTrack],
  );

  /**
   * Commit to a destination photo: pending advances now (so the pane window
   * grows to cover it on the next render and a follow-up commit can chain onto
   * it), the parent hears about it immediately, and the spring glides there.
   * If a spring is already in flight the commit just re-aims it — momentum is
   * preserved, and `boost` (button/keyboard nav) adds an impulse per click so
   * rapid clicking whips the strip faster instead of queueing hops.
   */
  const commitTo = useCallback(
    (dest, vel = 0, boost = false) => {
      setPending(dest);
      if (dest !== live.current.index) {
        lastEmittedRef.current = dest;
        onIndexChangeRef.current?.(dest);
      }
      const s = settleRef.current;
      if (s) {
        s.dest = dest;
        if (vel) s.v = vel * 1000;
        if (boost) s.v += Math.sign(paneX(dest) - s.x) * slideStep() * NAV_IMPULSE_STEPS_S;
        // Keep the watchdog honest — the settle stays alive while retargeted.
        if (s.timer != null) clearTimeout(s.timer);
        s.timer = setTimeout(finishSettle, SETTLE_TIMEOUT_MS);
        return;
      }
      const impulse = boost
        ? Math.sign(paneX(dest) - measureTrack()) * slideStep() * NAV_IMPULSE_STEPS_S
        : 0;
      settleTo(dest, (impulse / 1000) + vel);
    },
    [settleTo, setPending, paneX, slideStep, measureTrack, finishSettle],
  );

  useEffect(() => {
    if (!photo) return undefined;
    function onKey(e) {
      if (isClosingRef.current) return;
      if (e.key === "Escape") {
        if (infoOpen) {
          haptic("light");
          setInfoOpen(false);
        } else {
          requestClose();
        }
      }
      if (e.key === "ArrowLeft") {
        // Navigate from the committed destination, not the rendered prop —
        // held/rapid keys keep accumulating instead of waiting on animations.
        if (pendingRef.current > 0) {
          haptic("selection");
          commitTo(pendingRef.current - 1, 0, true);
        } else {
          haptic("rigid");
        }
      }
      if (e.key === "ArrowRight") {
        if (pendingRef.current < photos.length - 1) {
          haptic("selection");
          commitTo(pendingRef.current + 1, 0, true);
        } else {
          haptic("rigid");
        }
      }
      if (!guest && (e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        haptic("selection");
        onFavorite?.(photo);
      }
      if (!guest && e.key === "Delete") {
        e.preventDefault();
        onTrash?.(photo);
      }
      if ((e.key === "i" || e.key === "I") && !e.metaKey && !e.ctrlKey) {
        haptic("light");
        setInfoOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photo, index, photos.length, requestClose, onIndexChange, onFavorite, onTrash, guest, infoOpen, commitTo]);

  const syncTrack = useCallback(
    (fromLayout) => {
      if (gestureRef.current) return;
      const target = live.current.index;
      const pending = pendingRef.current;
      if (target !== pending) {
        if (target === lastEmittedRef.current) {
          // Our own commit landing late while the user already went elsewhere —
          // re-assert the real destination rather than snapping back.
          lastEmittedRef.current = pending;
          onIndexChangeRef.current?.(pending);
          return;
        }
        setPending(target);
      } else {
        // The commit landed (or never diverged) — external navigation is
        // authoritative again, so a stale emit can't hijack it later.
        lastEmittedRef.current = null;
      }
      const dest = pendingRef.current;
      const s = settleRef.current;
      if (s) {
        // In flight — re-aim the running spring instead of queueing or
        // dropping the navigation. Momentum carries through the retarget, and
        // the watchdog resets so a long chain can't snap mid-glide.
        s.dest = dest;
        if (s.timer != null) clearTimeout(s.timer);
        s.timer = setTimeout(finishSettle, SETTLE_TIMEOUT_MS);
        return;
      }
      const layout = fromLayout ?? live.current.layoutIndex;
      if (dest === layout) return;
      if (Math.abs(dest - layout) === 1) settleTo(dest, 0);
      else setLayoutIndex(dest);
    },
    [settleTo, setPending, finishSettle],
  );
  syncTrackRef.current = syncTrack;

  // After the pane window commits, keep the DOM translate honest — post-commit
  // but pre-paint, so a window shift never paints a displaced track. Leading
  // panes being added/removed shifts every pane's DOM-x by `df` steps, so the
  // translate (and any live spring/drag baseline) shifts with it — the pane
  // under the view never moves. When the window is stable and nothing is in
  // flight, pin to the anchor's resting spot.
  useLayoutEffect(() => {
    const prev = windowRef.current;
    windowRef.current = { first: firstPane, last: lastPane };
    if (!prev) {
      writeTrack(paneX(layoutIndex));
      return;
    }
    const df = prev.first - firstPane;
    if (df !== 0) {
      const dpx = df * slideStep();
      if (settleRef.current) settleRef.current.x -= dpx;
      if (gestureRef.current) gestureRef.current.grab -= dpx;
      writeTrack(measureTrack() - dpx);
      return;
    }
    if (gestureRef.current || settleRef.current) return;
    writeTrack(paneX(layoutIndex));
  }, [firstPane, lastPane, layoutIndex, photos.length, paneX, writeTrack, measureTrack, slideStep]);

  // Spring (or jump, for non-adjacent moves) when the parent changes `index`.
  useEffect(() => {
    syncTrack();
  }, [index, layoutIndex, syncTrack]);

  // Full-res media mounts only within ±1 of `primePane` — the trailing edge of
  // the committed destination. A single hop follows instantly (keeps neighbor
  // preloading for normal browsing); rapid chained navigation keeps `pending`
  // moving, so the panes we whip past stay thumbnail-only and never start a
  // heavy fetch. The "illusion": thumbs blur past, sharpness follows where
  // you stop.
  const [primePane, setPrimePane] = useState(index);
  const lastCommitT = useRef(0);
  useEffect(() => {
    if (primePane === pending) return undefined;
    const now = performance.now();
    const idleMs = now - lastCommitT.current;
    lastCommitT.current = now;
    if (idleMs > PRIME_DELAY_MS) {
      setPrimePane(pending);
      return undefined;
    }
    const t = setTimeout(() => setPrimePane(pending), PRIME_DELAY_MS);
    return () => clearTimeout(t);
  }, [pending, primePane]);

  // Stage resizes (info panel, orientation, window) change the pane step — the
  // px translate would go stale, so rescale it and any live spring/drag
  // baseline to keep the same fractional pane position under the view.
  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl || typeof ResizeObserver === "undefined") return undefined;
    let lastW = stageEl.clientWidth || 0;
    const ro = new ResizeObserver(() => {
      const w = stageEl.clientWidth || 0;
      if (!w || w === lastW) return;
      const oldTx = measureTrack();
      const tx = (oldTx / (lastW + PANE_GAP_PX)) * (w + PANE_GAP_PX);
      lastW = w;
      if (settleRef.current) settleRef.current.x = tx;
      if (gestureRef.current) gestureRef.current.grab += tx - oldTx;
      writeTrack(tx);
    });
    ro.observe(stageEl);
    return () => ro.disconnect();
  }, [measureTrack, writeTrack]);

  function onTouchStart(e) {
    if (isClosingRef.current) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    // A touch mid-spring grabs the track where it is — the DOM already holds
    // the live position and the committed destination stays pending, we just
    // stop the loop and continue from the measured offset.
    if (settleRef.current) {
      if (settleRef.current.raf != null) cancelAnimationFrame(settleRef.current.raf);
      if (settleRef.current.timer != null) clearTimeout(settleRef.current.timer);
      settleRef.current = null;
    }
    setReach(null);
    const grab = measureTrack();
    gestureRef.current = {
      x0: t.clientX,
      y0: t.clientY,
      lastX: t.clientX,
      lastT: performance.now(),
      vel: 0,
      axis: null,
      grab,
      near: Math.round((windowRef.current?.first ?? 0) - grab / slideStep()),
    };
  }

  function onTouchMove(e) {
    const g = gestureRef.current;
    if (!g) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (!g.axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      g.axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
    }
    if (g.axis !== "h") return;
    const now = performance.now();
    const dt = now - g.lastT;
    if (dt > 0) {
      g.vel = 0.7 * g.vel + 0.3 * ((t.clientX - g.lastX) / dt);
      g.lastX = t.clientX;
      g.lastT = now;
    }
    const step = slideStep();
    const { first, last } = windowRef.current ?? { first: 0, last: 0 };
    const len = live.current.photosLength;
    const rawTx = g.grab + dx;
    const posIdx = first - rawTx / step;
    // The window grows under the finger: request whichever pane the pull is
    // reaching toward so it mounts on the next commit — a long drag never
    // hits a wall, it just keeps sliding through the album.
    const wantFirst = Math.max(0, Math.floor(posIdx));
    const wantLast = Math.min(len - 1, Math.ceil(posIdx));
    if (wantFirst < first || wantLast > last) {
      setReach((r) => {
        const rf = Math.min(r?.first ?? wantFirst, wantFirst);
        const rl = Math.max(r?.last ?? wantLast, wantLast);
        return r && r.first === rf && r.last === rl ? r : { first: rf, last: rl };
      });
    }
    // Physical limits: free motion between the two end photos, diminishing-
    // returns rubber-band past photo 0's and photo len-1's centers.
    const firstBound = first * step;
    const lastBound = -(len - 1 - first) * step;
    let tx = rawTx;
    if (rawTx > firstBound) tx = firstBound + rubberBand(rawTx - firstBound, step);
    else if (rawTx < lastBound) tx = lastBound + rubberBand(rawTx - lastBound, step);
    // Detent tick: the strip feels like it has notches — a soft haptic each
    // time the nearest pane changes under the finger.
    const near = Math.max(0, Math.min(len - 1, Math.round(first - tx / step)));
    if (near !== g.near) {
      g.near = near;
      haptic("light");
    }
    // Direct DOM write — the photo rides the finger, no render round-trip.
    writeTrack(tx);
  }

  function endGesture(e, cancelled) {
    const g = gestureRef.current;
    gestureRef.current = null;
    setReach(null);
    if (!g) return;
    const step = slideStep();
    const { first } = windowRef.current ?? { first: 0 };
    const len = live.current.photosLength;
    const dx = (e.changedTouches?.[0]?.clientX ?? g.lastX) - g.x0;
    // The DOM holds the rubber-banded truth — measure it rather than trusting
    // grab+dx, which ignores the end-of-track resistance.
    const tx = measureTrack();
    // Pane position in fractional index units — 0.0 = photo 0.
    const curFloat = first - tx / step;
    let dest;
    let flicking = false;
    if (g.axis !== "h" || cancelled) {
      // Vertical grabs and cancelled touches just release at the nearest pane.
      dest = Math.round(curFloat);
    } else {
      // Land on the nearest pane to where the momentum carries — a hard fling
      // can skip a pane — and a deliberate flick always advances even from a
      // short drag.
      dest = Math.round(first - (tx + g.vel * FLING_PROJECT_MS) / step);
      const nearest = Math.round(curFloat);
      flicking = Math.abs(g.vel) > FLICK_VEL_PX_MS;
      if (flicking && dest === nearest) dest = nearest + (g.vel < 0 ? 1 : -1);
      // A real swipe suppresses the synthetic click that follows touchend —
      // otherwise lifting over a chevron fires a second navigation.
      if (Math.abs(dx) > AXIS_LOCK_PX) suppressClickRef.current = true;
    }
    const wanted = dest;
    dest = Math.max(0, Math.min(len - 1, dest));
    if (dest !== live.current.layoutIndex) haptic("selection");
    else if (wanted < 0 || wanted > len - 1) haptic("rigid");
    commitTo(dest, g.axis === "h" && !cancelled ? g.vel : 0);
  }

  if (!photo) return null;

  const dl = resolveDownloadSrc(photo, { downloadSrc });
  const folder = (photo.path || "").split("/").slice(0, -1).join("/");

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={photo.name}
      data-slot="photo-lightbox"
      data-mode={mode}
      className={cn(
        `fixed inset-0 ${LIGHTBOX_Z_CLASS} flex flex-col overscroll-none bg-primary text-secondary`,
        isClosing
          ? "fullscreen-overlay-exit file-viewer-exit"
          : "fullscreen-overlay-enter file-viewer-enter",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="font-mono text-sm truncate">{photo.name}</p>
        </div>
        <ActionTooltipGroup className="flex items-center gap-1 shrink-0">
          {!guest && onSlideshowChange && (
            <Tooltip
              content={slideshow ? "Stop slideshow" : "Start slideshow"}
              popupClassName="z-[100]"
            >
              <Button
                variant="ghost"
                surface="primary"
                size="icon"
                className="rounded-full"
                aria-label={slideshow ? "Stop slideshow" : "Start slideshow"}
                aria-pressed={slideshow}
                onClick={() => {
                  haptic("light");
                  onSlideshowChange(!slideshow);
                }}
              >
                <Play size={18} fill={slideshow ? "currentColor" : "none"} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Photo details" popupClassName="z-[100]">
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full"
              aria-label="Photo details"
              aria-pressed={infoOpen}
              onClick={() => {
                haptic("light");
                setInfoOpen((v) => !v);
              }}
            >
              <Info size={18} />
            </Button>
          </Tooltip>
          <Tooltip content="Close" popupClassName="z-[100]">
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full"
              onClick={requestClose}
              aria-label="Close"
            >
              <X size={20} />
            </Button>
          </Tooltip>
        </ActionTooltipGroup>
      </div>

      <div className="flex min-h-0 flex-1">
      <div
        ref={stageRef}
        data-slot="photo-lightbox-stage"
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 touch-pan-y"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={(e) => endGesture(e, false)}
        onTouchCancel={(e) => endGesture(e, true)}
        onClickCapture={(e) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {index > 0 && (
          <Tooltip content="Previous photo" popupClassName="z-[100]" className="absolute left-2 z-10">
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full shrink-0"
              aria-label="Previous"
              onClick={() => {
                const next = pendingRef.current - 1;
                if (next < 0) {
                  haptic("rigid");
                  return;
                }
                haptic("selection");
                commitTo(next, 0, true);
              }}
            >
              <ChevronLeft size={28} />
            </Button>
          </Tooltip>
        )}
        <div
          ref={trackElRef}
          data-slot="photo-lightbox-track"
          className="flex h-full w-full will-change-transform"
          // transform is owned entirely by the imperative path (drag writes,
          // spring ticks, and the window-shift compensation effect) — React
          // must never write it, or a mid-flight prop write teleports the track.
          style={{ columnGap: PANE_GAP_PX }}
        >
          {photos.slice(firstPane, lastPane + 1).map((p, paneI) => {
            const paneIndex = firstPane + paneI;
            const isCurrent = paneIndex === index;
            const paneSrc = isCurrent && contentSrc ? contentSrc : srcFor(p);
            // Transit panes (whipped past during chained navigation) mount only
            // their thumbnail — the full-res fetch waits until the destination
            // holds still, so a 10-click sprint never loads 10 photos.
            const lite = Math.abs(paneIndex - primePane) > 1;
            return (
              <div
                key={`${paneIndex}:${photoSelectionKey(p)}`}
                className="h-full w-full shrink-0 select-none"
                aria-hidden={!isCurrent || undefined}
              >
                <LightboxMedia
                  photo={p}
                  src={paneSrc}
                  downloadSrc={isCurrent && downloadSrc ? downloadSrc : resolveDownloadSrc(p)}
                  autoPlay={isCurrent ? !slideshow : false}
                  lite={lite}
                />
              </div>
            );
          })}
        </div>
        {index < photos.length - 1 && (
          <Tooltip content="Next photo" popupClassName="z-[100]" className="absolute right-2 z-10">
            <Button
              variant="ghost"
              surface="primary"
              size="icon"
              className="rounded-full shrink-0"
              aria-label="Next"
              onClick={() => {
                const next = pendingRef.current + 1;
                if (next > photos.length - 1) {
                  haptic("rigid");
                  return;
                }
                haptic("selection");
                commitTo(next, 0, true);
              }}
            >
              <ChevronRight size={28} />
            </Button>
          </Tooltip>
        )}
      </div>

      <PhotoInfoPanel
        photo={photo}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        photos={photos}
        onSelectPhoto={(p) => {
          const next = photos.indexOf(p);
          if (next >= 0 && next !== index) {
            haptic("selection");
            onIndexChange(next);
          }
        }}
      />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-4">
        <ActionTooltipGroup className="flex flex-wrap items-center gap-2 rounded-pill bg-secondary text-primary px-2 py-2">
          {!guest && (
            <Tooltip
              content={photo.favorited ? "Remove from favorites" : "Favorite"}
              popupClassName="z-[100]"
            >
              <Button
                variant="ghost"
                size="sm"
                loading={favoriting}
                onClick={() => {
                  haptic("selection");
                  onFavorite?.(photo);
                }}
                aria-label={photo.favorited ? "Remove favorite" : "Favorite"}
              >
                <Heart size={18} fill={photo.favorited ? "currentColor" : "none"} />
              </Button>
            </Tooltip>
          )}
          {!guest && (
            <Tooltip content="Add to album" popupClassName="z-[100]">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  haptic("light");
                  onAlbum?.(photo);
                }}
                aria-label="Add to album"
              >
                <Images size={18} />
              </Button>
            </Tooltip>
          )}
          {!guest && onSetCover && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                haptic("selection");
                onSetCover(photo);
              }}
              aria-label="Set as album cover"
            >
              Set as cover
            </Button>
          )}
          {!guest && (
            <Tooltip content="Copy a share link" popupClassName="z-[100]">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  haptic("light");
                  onShare?.(photo);
                }}
                aria-label="Share link"
              >
                <Link2 size={18} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Download" popupClassName="z-[100]">
            <Button variant="ghost" size="sm" asChild>
              <a href={dl} download onClick={() => haptic("light")}>
                <Download size={18} />
                <span className="sr-only">Download</span>
              </a>
            </Button>
          </Tooltip>
          {!guest && photo.drive_id && (
            <Tooltip content="Open folder" popupClassName="z-[100]">
              <Button variant="ghost" size="sm" asChild>
                <Link to={folderHref(photo.drive_id, folder)} onClick={() => haptic("selection")}>
                  <FolderOpen size={18} />
                  <span className="sr-only">Open folder</span>
                </Link>
              </Button>
            </Tooltip>
          )}
          {!guest && (
            <Tooltip content="Move to trash" popupClassName="z-[100]">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  haptic("warning");
                  onTrash?.(photo);
                }}
                aria-label="Move to trash"
              >
                <Trash2 size={18} />
              </Button>
            </Tooltip>
          )}
        </ActionTooltipGroup>
      </div>
    </div>,
    document.body,
  );
}

PhotoLightbox.propTypes = {
  photos: PropTypes.arrayOf(PropTypes.object).isRequired,
  index: PropTypes.number,
  photoKey: PropTypes.string,
  mode: PropTypes.oneOf(["owner", "guest"]),
  contentSrc: PropTypes.string,
  downloadSrc: PropTypes.string,
  srcFor: PropTypes.func,
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onIndexChange: PropTypes.func.isRequired,
  onFavorite: PropTypes.func,
  onShare: PropTypes.func,
  onAlbum: PropTypes.func,
  onTrash: PropTypes.func,
  onSetCover: PropTypes.func,
  slideshow: PropTypes.bool,
  onSlideshowChange: PropTypes.func,
  favoriting: PropTypes.bool,
};

PhotoLightbox.defaultProps = {
  favoriting: false,
  mode: "owner",
  open: true,
  slideshow: false,
  srcFor: resolveDisplaySrc,
};
