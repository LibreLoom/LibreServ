import { Settings, Palette, Shield, Info, DatabaseBackup, Globe, Bell, Plug } from "lucide-react";

// adminOnly categories change server-side settings a regular user cannot touch,
// so they are hidden from non-admins (seeing settings you can't change is just
// confusing). Appearance is a client-side preference and About is read-only, so
// both stay available to everyone.
export const CATEGORIES = [
  { id: "external_services", label: "External Services", icon: Plug, adminOnly: true },
  { id: "general", label: "General", icon: Settings, adminOnly: true },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "backups", label: "Backups", icon: DatabaseBackup, adminOnly: true },
  { id: "security", label: "Security", icon: Shield, adminOnly: true },
  { id: "network", label: "Network", icon: Globe, adminOnly: true },
  { id: "notifications", label: "Notifications", icon: Bell, adminOnly: true },
  { id: "about", label: "About", icon: Info },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin) {
  return CATEGORIES.filter((c) => isAdmin || !c.adminOnly);
}
