import {
  Cpu,
  HardDrive,
  Wifi,
  MemoryStick,
} from "lucide-react";

/** Resources that make up the stress index, in display order. */
const RESOURCES = [
  { key: "cpu", label: "CPU", icon: Cpu },
  { key: "ram", label: "RAM", icon: MemoryStick },
  { key: "disk", label: "Disk", icon: HardDrive },
  { key: "net", label: "Network", icon: Wifi },
];

/**
 * Share of the headroom left by the bottleneck that the remaining resources
 * can consume when they are *all* maxed out. Below 1 so that secondary load
 * can never on its own drive the index to 100%.
 */
const REST_PRESSURE = 0.6;

/** Each next-worst resource carries this fraction of the previous one's say. */
const RANK_DECAY = 0.6;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function getBreakdownItems(resources) {
  // Map normalized metrics to UI-friendly percentage labels and icons.
  if (!resources) return [];
  return RESOURCES.map(({ key, label, icon }) => ({
    icon,
    label,
    value: Math.round(clamp01(resources[key]) * 100) + "%",
  }));
}

/**
 * Aggregate the per-resource loads into a single "stress index" in [0, 1].
 *
 * A server is only as healthy as its worst resource, so a plain weighted
 * average lies: a saturated network diluted by three idle resources used to
 * read as ~30% stress. Instead the worst resource sets the floor, and the
 * remaining ones eat into the headroom above it, with each next-worst
 * resource mattering less than the one before it. That makes the index
 * nonlinear in a way that matches intuition:
 *
 *   0/0/0/0     -> 0%    (nothing is under load)
 *   0/0/0/100   -> 100%  (one saturated resource stalls the whole server)
 *   50/50/50/50 -> 65%   (broad moderate load is worse than a single one)
 */
export function totalResourceUsage(resources) {
  const loads = RESOURCES.map(({ key }) => clamp01(resources?.[key])).sort(
    (a, b) => b - a,
  );

  const [bottleneck, ...rest] = loads;
  if (bottleneck >= 1 || rest.length === 0) return bottleneck;

  // Rank-weighted mean of the non-bottleneck resources. Weighting by rank
  // rather than by resource keeps the index continuous: whichever resource
  // happens to be the bottleneck, equal loads produce equal stress.
  let share = 1;
  let weighted = 0;
  let totalShare = 0;
  for (const load of rest) {
    weighted += share * load;
    totalShare += share;
    share *= RANK_DECAY;
  }
  const secondary = totalShare > 0 ? weighted / totalShare : 0;

  return bottleneck + (1 - bottleneck) * REST_PRESSURE * secondary;
}
