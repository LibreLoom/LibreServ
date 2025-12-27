import {
  Cpu,
  HardDrive,
  Search,
  Cloud,
  Wifi,
  Zap,
  MemoryStick,
  FileSliders,
} from "lucide-react";

// TODO: Replace with API calls
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
      energy: 0.5,
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
      energy: 0.4,
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
      energy: 0.03,
    },
  },
];

export const resources = {
  cpu: 0.35,
  ram: 0.6,
  disk: 0.25,
  net: 0.4,
  energy: 0.5,
};

export function getBreakdownItems(resources) {
  if (!resources) return [];
  return [
    { icon: Cpu, label: "CPU", value: Math.round(resources.cpu * 100) + "%" },
    { icon: MemoryStick, label: "RAM", value: Math.round(resources.ram * 100) + "%" },
    { icon: HardDrive, label: "Disk", value: Math.round(resources.disk * 100) + "%" },
    { icon: Wifi, label: "Network", value: Math.round(resources.net * 100) + "%" },
    { icon: Zap, label: "Energy", value: Math.round(resources.energy * 100) + "%" },
  ];
}

export function totalResourceUsage({ cpu, ram, disk, net }) {
  const weights = { cpu: 0.3, ram: 0.25, disk: 0.2, net: 0.15 };
  return cpu * weights.cpu + ram * weights.ram + disk * weights.disk + net * weights.net;
}
