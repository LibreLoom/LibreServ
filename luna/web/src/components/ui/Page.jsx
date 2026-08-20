import { cn } from "@/lib/utils";
import HeaderCard from "../cards/HeaderCard";
import Card from "../cards/Card";

/**
 * Page — the standard authenticated page shell.
 *
 * Renders the `<main>` with the correct base surface tokens
 * (`bg-primary text-secondary`), consistent padding, the skip-link target
 * (`id="main-content"` + `tabIndex={-1}` for focus restoration), and an
 * optional HeaderCard. Use this on every routed page so the base text color
 * is always correct and the boilerplate isn't hand-copied.
 *
 * HeaderCard is always one line. `bottomContent` (taglines, leads) renders
 * BELOW the header card — never inside it as a stacked second card. Put
 * navigation in the bottom Navbar, not in the header.
 *
 * @param {object} props
 * @param {import("react").ReactNode} [props.title] Page heading. Omit for pages that render their own header.
 * @param {string} [props.titleId] id for aria-labelledby (defaults to a derived slug).
 * @param {import("react").ReactNode} [props.leftContent] Same-row header chrome only (icons/status). Not for nav.
 * @param {import("react").ReactNode} [props.rightContent] Same-row header chrome only. Not for nav.
 * @param {import("react").ReactNode} [props.bottomContent] Lead/tagline below the header card (not inside it).
 * @param {string} [props.headerClassName] Margin/spacing for the header wrapper. Default "mb-8".
 * @param {string} [props.headerCardClassName] Extra classes passed to the HeaderCard itself (e.g. "group").
 * @param {boolean} [props.padded] Whether to apply horizontal page padding (px-8). Default true. Set false for full-bleed pages that pad inner sections themselves.
 * @param {string} [props.className] Extra classes appended to `<main>`.
 * @param {import("react").ReactNode} [props.children]
 */
export default function Page({
  title,
  titleId,
  leftContent,
  rightContent,
  bottomContent,
  headerClassName = "mb-8",
  headerCardClassName = "",
  padded = true,
  className = "",
  children,
}) {
  const id = titleId || (title ? "main-content-title" : undefined);
  const hasLead =
    bottomContent != null &&
    (typeof bottomContent !== "string" || bottomContent.trim().length > 0);

  return (
    <main
      data-slot="page"
      className={cn("bg-primary text-secondary pt-5 pb-32", padded && "px-8", className)}
      aria-labelledby={title ? id : undefined}
      id="main-content"
      tabIndex={-1}
    >
      {title && (
        <header className={cn(headerClassName, hasLead && "mb-4")}>
          <HeaderCard
            id={id}
            title={title}
            leftContent={leftContent}
            rightContent={rightContent}
            className={headerCardClassName}
          />
          {hasLead && (
            <Card className="text-center mb-4" data-slot="page-lead">
              {bottomContent}
            </Card>
          )}
        </header>
      )}
      {children}
    </main>
  );
}
