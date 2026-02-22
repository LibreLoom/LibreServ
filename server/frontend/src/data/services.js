import {
  Cpu,
  HardDrive,
  Search,
  Cloud,
  Wifi,
  MemoryStick,
  FileSliders,
} from "lucide-react";

// TODO: Replace with API calls
// Resource values are normalized (0..1) so cards can format and combine them.
// Mock service list used by cards and detail views until live data is wired in.
export const services = [
  {
    name: "SearXNG",
    status: "warning",
    time: "14 days, 3 hours",
    warningMessage: "High latency detected",
    resourceUsage: 10,
    icon: Search,
    resources: {
      cpu: 0.35,
      ram: 0.6,
      disk: 0.25,
      net: 0.4,
    },
  },
  {
    name: "Nextcloud",
    status: "online",
    time: "14 days, 3 hours",
    resourceUsage: 60,
    icon: Cloud,
    resources: {
      cpu: 0.45,
      ram: 0.7,
      disk: 0.55,
      net: 0.3,
    },
  },
  {
    name: "Convertx",
    status: "offline",
    time: "14 days, 3 hours",
    resourceUsage: 3,
    icon: FileSliders,
    resources: {
      cpu: 0.02,
      ram: 0.05,
      disk: 0.01,
      net: 0.0,
    },
  },
];

export const resources = {
  cpu: 0.35,
  ram: 0.6,
  disk: 0.25,
  net: 0.4,
};

export function getBreakdownItems(resources) {
  // Map normalized metrics to UI-friendly percentage labels and icons.
  if (!resources) return [];
  return [
    { icon: Cpu, label: "CPU", value: Math.round(resources.cpu * 100) + "%" },
    {
      icon: MemoryStick,
      label: "RAM",
      value: Math.round(resources.ram * 100) + "%",
    },
    {
      icon: HardDrive,
      label: "Disk",
      value: Math.round(resources.disk * 100) + "%",
    },
    {
      icon: Wifi,
      label: "Network",
      value: Math.round(resources.net * 100) + "%",
    },
  ];
}

export function totalResourceUsage({ cpu, ram, disk, net }) {
  // Weighted aggregate keeps the "stress index" stable across categories.
  const weights = { cpu: 0.3, ram: 0.25, disk: 0.2, net: 0.15 };
  return (
    cpu * weights.cpu +
    ram * weights.ram +
    disk * weights.disk +
    net * weights.net
  );
}
