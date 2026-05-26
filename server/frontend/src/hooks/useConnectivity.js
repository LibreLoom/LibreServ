import { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

export function useConnectivity(refreshInterval = 30000) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchConnectivity = useCallback(async () => {
    try {
      const res = await api("/network/connectivity");
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setError(null);
      } else {
        setError("Failed to fetch connectivity status");
      }
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnectivity();
    const interval = setInterval(fetchConnectivity, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchConnectivity, refreshInterval]);

  return { data, loading, error, refresh: fetchConnectivity };
}

export function getRemoteAccessStatus(connectivityData) {
  if (!connectivityData) {
    return {
      status: "unknown",
      text: "Checking...",
      icon: null,
      className: "text-secondary/50",
    };
  }

  switch (connectivityData.remote_access) {
    case "active":
      return {
        status: "active",
        text: "Remote Access Active",
        icon: "check-circle",
        className: "text-success",
      };
    case "degraded":
      return {
        status: "degraded",
        text: "Limited Remote Access",
        icon: "alert-circle",
        className: "text-warning",
      };
    case "blocked":
      return {
        status: "blocked",
        text: "Remote Access Blocked",
        icon: "x-circle",
        className: "text-error",
      };
    case "local_only":
    default:
      return {
        status: "local_only",
        text: "Local Access Only",
        icon: "wifi-off",
        className: "text-accent",
      };
  }
}
