import {
  DatabaseBackup,
  Globe2,
  Info,
  Laptop,
  Palette,
  Shield,
  Cable,
} from "lucide-react";

// adminOnly categories change this Luna itself (network, updates, backups),
// so they stay hidden from members who cannot change them.
// Labels match LibreServ's clean category style (Appearance, Network, Backups,
// Security, About) rather than euphemistic phrasing.
const CATEGORIES = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "network", label: "Network", icon: Cable, adminOnly: true },
  { id: "remote", label: "Remote Access", icon: Globe2, adminOnly: true },
  { id: "backups", label: "Backups", icon: DatabaseBackup, adminOnly: true },
  { id: "security", label: "Security", icon: Shield },
  { id: "devices", label: "Devices", icon: Laptop },
  { id: "about", label: "About", icon: Info, adminOnly: true },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin) {
  return CATEGORIES.filter((c) => isAdmin || !c.adminOnly);
}
