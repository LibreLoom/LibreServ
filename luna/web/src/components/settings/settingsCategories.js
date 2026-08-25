import { Cloud, Download, FolderOpen, Keyboard, LogOut, Palette, Smartphone, Wifi } from "lucide-react";

// adminOnly categories change this Luna itself (network, updates, cloud copy),
// so they stay hidden from household members who cannot change them.
const CATEGORIES = [
  { id: "appearance", label: "Look and feel", icon: Palette },
  { id: "network", label: "This house's network", icon: Wifi, adminOnly: true },
  { id: "cloud", label: "Spare copy in the cloud", icon: Cloud, adminOnly: true },
  { id: "devices", label: "Phones and computers", icon: FolderOpen },
  { id: "apps", label: "Apps and helper tools", icon: Smartphone },
  { id: "password", label: "If you forget your password", icon: Keyboard },
  { id: "signed_in", label: "Who is signed in", icon: LogOut },
  { id: "updates", label: "Software updates", icon: Download, adminOnly: true },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin) {
  return CATEGORIES.filter((c) => isAdmin || !c.adminOnly);
}
