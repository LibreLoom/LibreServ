import { Cloud, Info, Laptop, Palette, Plug, Shield, Users } from "lucide-react";

// adminOnly categories change this Luna itself (Luna Connect, updates),
// so they stay hidden from members who cannot change them.
// connectOnly categories show only while Luna Connect is active on this Luna.
// Cloud backup always shows: the recovery phrase card lives there.
// Labels match Sol's clean category style (Appearance, Security, About)
// rather than euphemistic phrasing.
const CATEGORIES = [
  { id: "cloud_backup", label: "Cloud backup", icon: Cloud },
  { id: "luna_connect", label: "Luna Connect", icon: Plug, adminOnly: true, connectOnly: true },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "security", label: "Security", icon: Shield },
  { id: "users", label: "Users", icon: Users, adminOnly: true },
  { id: "devices", label: "Devices", icon: Laptop },
  { id: "about", label: "About", icon: Info, adminOnly: true },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin, connectActive = false) {
  return CATEGORIES.filter((c) => {
    if (c.connectOnly && !connectActive) return false;
    return isAdmin || !c.adminOnly;
  });
}
