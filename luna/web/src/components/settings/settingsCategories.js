import { Cloud, Download, FolderOpen, KeyRound, Palette, Wifi, Globe2 } from "lucide-react";

// adminOnly categories change this Luna itself (network, updates, cloud backup),
// so they stay hidden from members who cannot change them.
const CATEGORIES = [
  { id: "appearance", label: "Look and feel", icon: Palette },
  { id: "network", label: "Home network", icon: Wifi, adminOnly: true },
  { id: "remote", label: "Remote access", icon: Globe2, adminOnly: true },
  { id: "cloud", label: "Cloud backup", icon: Cloud, adminOnly: true },
  { id: "devices", label: "Phones and computers", icon: FolderOpen },
  { id: "access", label: "Access", icon: KeyRound },
  { id: "updates", label: "Software updates", icon: Download, adminOnly: true },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin) {
  return CATEGORIES.filter((c) => isAdmin || !c.adminOnly);
}
