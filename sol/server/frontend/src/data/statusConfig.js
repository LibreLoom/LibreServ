import { CheckCircle, XCircle, AlertCircle, Circle } from "lucide-react";

export const statusConfig = {
  running: {
    icon: CheckCircle,
    label: "Running",
  },
  stopped: {
    icon: XCircle,
    label: "Stopped",
  },
  error: {
    icon: AlertCircle,
    label: "Error",
  },
  unknown: {
    icon: Circle,
    label: "Unknown",
  },
  online: {
    icon: CheckCircle,
    color: "text-success",
    bg: "surface-secondary",
    label: "Online",
  },
  offline: {
    icon: XCircle,
    color: "text-error",
    bg: "surface-secondary",
    label: "Offline",
  },
  warning: {
    icon: AlertCircle,
    color: "text-warning",
    bg: "surface-secondary",
    label: "Warning",
  },
};

