import { Info, Laptop, Palette, Plug, Shield, Users } from "lucide-react";

// adminOnly categories change this Luna itself (external services, updates),
// so they stay hidden from members who cannot change them.
// Labels match Sol's clean category style (Appearance, External services,
// Security, About) rather than euphemistic phrasing.
const CATEGORIES = [
  { id: "external_services", label: "External services", icon: Plug, adminOnly: true },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "security", label: "Security", icon: Shield },
  { id: "users", label: "Users", icon: Users, adminOnly: true },
  { id: "devices", label: "Devices", icon: Laptop },
  { id: "about", label: "About", icon: Info, adminOnly: true },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin) {
  return CATEGORIES.filter((c) => {
    return isAdmin || !c.adminOnly;
  });
}
