import {
  Cpu,
  HardDrive,
  Wifi,
  MemoryStick,
} from "lucide-react";

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
