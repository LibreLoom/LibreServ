import { Info, Laptop, Palette, Plug, Shield, Cable } from "lucide-react";

// adminOnly categories change this Luna itself (network, external services, updates),
// so they stay hidden from members who cannot change them.
// Labels match LibreServ's clean category style (Appearance, External Services,
// Security, About) rather than euphemistic phrasing.
const CATEGORIES = [
  { id: "external_services", label: "External Services", icon: Plug, adminOnly: true },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "network", label: "Local Network", icon: Cable, adminOnly: true },
  { id: "security", label: "Security", icon: Shield },
  { id: "devices", label: "Devices", icon: Laptop },
  { id: "about", label: "About", icon: Info, adminOnly: true },
];

/** Categories visible to a user with the given admin status. */
export function visibleCategories(isAdmin) {
  return CATEGORIES.filter((c) => isAdmin || !c.adminOnly);
}
