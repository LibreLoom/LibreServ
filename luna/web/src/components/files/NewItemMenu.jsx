import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { ChevronDown, Plus } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { createKindsFor, groupedCreateKinds } from "../../lib/createKinds.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";

/**
 * One New button that opens a growing list of create kinds.
 *
 * A single kind (folder-only pickers) skips the menu and goes straight to
 * that action. Adding office types later is a catalog change, not more
 * toolbar buttons.
 *
 * @param {{
 *   onPick: (kind: import("../../lib/createKinds.js").CreateKind) => void,
 *   ids?: string[],
 *   allowPrivate?: boolean,
 *   surface?: "primary" | "secondary",
 * }} props
 */
export default function NewItemMenu({ onPick, ids, allowPrivate = false, surface = "secondary" }) {
  const kinds = useMemo(() => createKindsFor(ids, allowPrivate), [ids, allowPrivate]);
  const groups = useMemo(() => groupedCreateKinds(kinds), [kinds]);
  const showGroupLabels = groups.length > 1;
  const single = kinds.length === 1 ? kinds[0] : null;
  const [open, setOpen] = useState(false);

  const options = useMemo(
    () =>
      groups.flatMap((group) =>
        group.items.map((kind) => ({
          value: kind.id,
          label: kind.label,
          icon: kind.icon,
          group: showGroupLabels ? group.label : undefined,
        })),
      ),
    [groups, showGroupLabels],
  );

  function pickKind(kind) {
    haptic("selection");
    onPick(kind);
  }

  function toggle() {
    if (single) {
      pickKind(single);
      return;
    }
    haptic("light");
    setOpen((o) => !o);
  }

  useShortcut("n", toggle, { label: "New file or folder", group: "Files" });

  if (single) {
    return (
      <Button
        variant="outline"
        surface={surface}
        size="sm"
        type="button"
        haptic={false}
        aria-label={`New ${single.label.toLowerCase()}`}
        onClick={toggle}
      >
        <single.icon size={ICON_SIZE.sm} aria-hidden="true" />
        {`New ${single.label.toLowerCase()}`}
      </Button>
    );
  }

  return (
    <Dropdown
      menu
      menuLabel="New"
      options={options}
      value=""
      open={open}
      onOpenChange={setOpen}
      onChange={(id) => {
        const kind = kinds.find((k) => k.id === id);
        if (kind) onPick(kind);
      }}
      renderTrigger={({ open: isOpen, toggle: dropdownToggle, onKeyDown }) => (
        <Button
          variant="outline"
          surface={surface}
          size="sm"
          type="button"
          haptic={false}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-label="New"
          onClick={dropdownToggle}
          onKeyDown={onKeyDown}
        >
          <Plus size={ICON_SIZE.sm} aria-hidden="true" />
          New
          <ChevronDown
            size={ICON_SIZE.sm}
            aria-hidden="true"
            className={cn(
              "motion-safe:transition-transform motion-safe:duration-300",
              isOpen ? "rotate-180" : "rotate-0",
            )}
          />
        </Button>
      )}
    />
  );
}

NewItemMenu.propTypes = {
  onPick: PropTypes.func.isRequired,
  ids: PropTypes.arrayOf(PropTypes.string),
  allowPrivate: PropTypes.bool,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};
