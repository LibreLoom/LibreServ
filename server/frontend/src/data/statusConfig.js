import { CheckCircle, XCircle, AlertCircle, Circle, Shield, Activity } from "lucide-react";

export const statusConfig = {
  running: {
    icon: CheckCircle,
    label: "Running",
    colorVar: "--color-success",
    bgVar: "--bg-success",
  },
  stopped: {
    icon: XCircle,
    label: "Stopped",
    colorVar: "--color-warning",
    bgVar: "--bg-warning",
  },
  error: {
    icon: AlertCircle,
    label: "Error",
    colorVar: "--color-error",
    bgVar: "--bg-error",
  },
  unknown: {
    icon: Circle,
    label: "Unknown",
    colorVar: "var(--color-secondary)",
    bgVar: "var(--bg-info)",
  },
  online: {
    icon: CheckCircle,
    color: "text-accent",
    bg: "bg-secondary",
    label: "Online",
  },
  offline: {
    icon: XCircle,
    color: "text-accent",
    bg: "bg-secondary",
    label: "Offline",
  },
  warning: {
    icon: AlertCircle,
    color: "text-accent",
    bg: "bg-secondary",
    label: "Warning",
  },
};

export const resourceLabels = {
  cpu: "CPU",
  ram: "RAM",
  disk: "Disk",
  net: "Network",
  energy: "Energy",
};

export function normalizeResources(resources) {
  if (!resources) return [];
  if (Array.isArray(resources)) return resources;

  return Object.entries(resources).map(([key, value]) => ({
    label: resourceLabels[key] || key.toUpperCase(),
    value: Math.round(value * 100),
  }));
}

export function getStatusText(status, time, warningMessage) {
  if (status === "online" && time) {
    return `Uptime: ${time}`;
  }
  if (status === "offline" && time) {
    return `Downtime: ${time}`;
  }
  if (status === "warning" && warningMessage) {
    return warningMessage;
  }
  return null;
}

export const roleConfig = {
  admin: {
    icon: Shield,
    color: "text-accent",
    label: "Admin",
  },
  user: {
    icon: Activity,
    color: "text-primary",
    label: "User",
  },
};
