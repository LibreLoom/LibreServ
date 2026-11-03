import { useState } from "react";
import PropTypes from "prop-types";
import { Zap } from "lucide-react";
import Button from "./Button.jsx";
import CardButton from "./CardButton.jsx";
import ModalCard from "../cards/ModalCard.jsx";

/**
 * One action a row can offer. The row renders it as an icon button on wide
 * screens and as a labeled row in the phone sheet — same list, same order.
 *
 * @typedef {object} RowAction
 * @property {string} key
 * @property {string} label Visible words in the sheet, and the icon's tooltip.
 * @property {string} [aria] The icon button's accessible name, when it isn't `label`.
 * @property {import('react').ElementType} [icon]
 * @property {boolean} [danger] Paints the sheet row as destructive.
 * @property {boolean} [text] The wide row spells this one out instead of an icon.
 * @property {boolean} [rowHidden] Sheet only: the row draws this action itself.
 * @property {string} [to] A router path: the sheet row becomes a link.
 * @property {string} [href] A plain link (a download) instead of a button.
 * @property {() => void} [run] Everything else is a button.
 */

/**
 * The body of a row's action sheet: one labeled row per action, all the same
 * height. Rendered inside a `ModalCard`, which supplies `close`.
 *
 * @param {{ actions: RowAction[], close: () => void }} props
 */
export function RowActionSheet({ actions, close }) {
  return (
    <div className="grid gap-2">
      {actions.map(({ key, label, icon: Icon, danger, to, href, run }) => (
        <CardButton
          key={key}
          variant={danger ? "danger" : "default"}
          action={to}
          actionLabel={label}
          icon={Icon}
          align="start"
          className="mt-0"
          onClick={() => {
            close();
            if (href) window.location.assign(href);
            else run?.();
          }}
        >
          {label}
        </CardButton>
      ))}
    </div>
  );
}

RowActionSheet.propTypes = {
  actions: PropTypes.arrayOf(PropTypes.shape({
    key: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    icon: PropTypes.elementType,
    danger: PropTypes.bool,
    to: PropTypes.string,
    href: PropTypes.string,
    run: PropTypes.func,
  })).isRequired,
  close: PropTypes.func.isRequired,
};

/**
 * The small-screen row action button: one lightning button that opens a sheet
 * of the row's actions, instead of a wall of icons squeezing the name away.
 *
 * Universal Search and the file explorer each used to own a copy of this, and
 * they drifted — one sheet's destructive row kept the danger card's extra
 * padding and came out half again as tall as the actions around it. One
 * component means one size for every row in the sheet.
 *
 * `surface` is the only thing the two contexts disagree on: search results are
 * `surface-primary` rows, file rows sit on whatever surface the listing uses.
 * It is the one prop.
 *
 * A caller with its own sheet body (the explorer, whose rows carry more
 * actions than the built-in set) passes `renderSheet` instead of `actions`;
 * it should return `<RowActionSheet>` so the rows keep one shape.
 *
 * @param {{
 *   label: string,
 *   actions?: RowAction[],
 *   renderSheet?: (close: () => void) => import('react').ReactNode,
 *   surface?: "primary" | "secondary",
 * }} props
 */
export default function RowActionMenu({ label, actions, renderSheet, surface = "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        surface={surface}
        size="icon"
        className="size-11"
        aria-label={`Actions for ${label}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Zap size={24} aria-hidden="true" />
      </Button>
      <ModalCard open={open} title={label} size="sm" onClose={() => setOpen(false)}>
        {({ close }) => (renderSheet ? renderSheet(close) : <RowActionSheet actions={actions} close={close} />)}
      </ModalCard>
    </>
  );
}

RowActionMenu.propTypes = {
  label: PropTypes.string.isRequired,
  actions: PropTypes.arrayOf(PropTypes.shape({
    key: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    icon: PropTypes.elementType,
    danger: PropTypes.bool,
    to: PropTypes.string,
    href: PropTypes.string,
    run: PropTypes.func,
  })),
  renderSheet: PropTypes.func,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};
