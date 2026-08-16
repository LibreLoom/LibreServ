import { cn } from "@/lib/utils";
import HeaderCard from "../cards/HeaderCard";

/**
 * Page — the standard authenticated page shell.
 *
 * Renders the `<main>` with the correct base surface tokens
 * (`bg-primary text-secondary`), consistent padding, the skip-link target
 * (`id="main-content"` + `tabIndex={-1}` for focus restoration), and an
 * optional HeaderCard. Use this on every routed page so the base text color
 * is always correct and the boilerplate isn't hand-copied.
 *
 * @param {object} props
 * @param {import("react").ReactNode} [props.title] Page heading. Omit for pages that render their own header.
 * @param {string} [props.titleId] id for aria-labelledby (defaults to a derived slug).
 * @param {import("react").ReactNode} [props.leftContent]
 * @param {import("react").ReactNode} [props.rightContent]
 * @param {import("react").ReactNode} [props.bottomContent]
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
  return (
    <main
      data-slot="page"
      className={cn("bg-primary text-secondary pt-5 pb-32", padded && "px-8", className)}
      aria-labelledby={title ? id : undefined}
      id="main-content"
      tabIndex={-1}
    >
      {title && (
        <header className={headerClassName}>
          <HeaderCard
            id={id}
            title={title}
            leftContent={leftContent}
            rightContent={rightContent}
            bottomContent={bottomContent}
            className={headerCardClassName}
          />
        </header>
      )}
      {children}
    </main>
  );
}
