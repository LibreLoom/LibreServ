import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { getDrives, recordRecent } from "../lib/api.js";
import { recentItemFromLocation, recordRecentItem } from "../lib/recentItems.js";

/**
 * Watches the route and records the file/folder/drive being browsed into the
 * signed-in user's recent list (server backed + localStorage fallback). Mount once inside the
 * authenticated app shell — see RecentItemsTracker in App.jsx.
 */
export default function useRecentItemsTracker() {
  const location = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const username = user?.username;
  const driveList = drives.data;

  useEffect(() => {
    if (!username) return;
    const item = recentItemFromLocation(location);
    if (!item) return;
    const driveLabel = Array.isArray(driveList)
      ? driveList.find((d) => d.id === item.driveId)?.label
      : undefined;
    recordRecentItem(username, { ...item, driveLabel });
    recordRecent({ kind: item.kind, driveId: item.driveId, path: item.path })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["recents"] });
      })
      .catch(() => {
        // Recents are a convenience, never fatal
      });
  }, [location, username, driveList, queryClient]);
}
