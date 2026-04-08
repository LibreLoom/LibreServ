import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export function useSystemHardware() {
  return useQuery({
    queryKey: ["system", "hardware"],
    queryFn: async () => {
      const res = await api("/system/hardware");
      const data = await res.json();
      return data;
    },
    staleTime: 60_000,
  });
}

export function useSystemHardwareReport() {
  return useQuery({
    queryKey: ["system", "hardware", "report"],
    queryFn: async () => {
      const res = await api("/system/hardware/report");
      const text = await res.text();
      return text;
    },
    staleTime: 60_000,
  });
}
