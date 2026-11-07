import { Info, Laptop, Palette, Plug, Shield, Users } from "lucide-react";

// adminOnly categories change this Luna itself (updates), so they stay hidden
// from members who cannot change them.
// Luna Connect and cloud backup share one entry: the address, the device
// token and what is stored in the cloud are one thing to the person using
// them, and the recovery phrase card lives there too.
// Labels match Sol's clean category style (Appearance, Security, About)
// rather than euphemistic phrasing.
const CATEGORIES = [
  { id: "luna_connect", label: "Luna Connect", icon: Plug },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "security", label: "Security", icon: Shield },
  { id: "users", label: "Users", icon: Users, adminOnly: true },
  { id: "devices", label: "Devices", icon: Laptop },
  { id: "about", label: "About", icon: Info, adminOnly: true },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin, _connectActive = false) {
  return CATEGORIES.filter((c) => isAdmin || !c.adminOnly);
}
