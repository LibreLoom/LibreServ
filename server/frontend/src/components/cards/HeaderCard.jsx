import { cn } from "@/lib/utils";
import Card from "./Card";

/**
 * HeaderCard — the page title surface. ALWAYS a single one-line card.
 *
 * FORBIDDEN: stacking a second/third Card under the title for back links,
 * actions, or taglines (the old mobile `xl:hidden` vertical split). That
 * pattern is banned across LibreServ and Luna.
 *
 * - Title stays one line (`truncate` if needed).
 * - Optional `leftContent` / `rightContent` sit on the SAME row.
 * - Do NOT put navigation here. Use the bottom Navbar.
 * - Do NOT put multi-line taglines here. Put them in the page body
 *   (Page's `bottomContent` renders below this card, not inside it).
 *
 * @typedef {object} HeaderCardProps
 * @property {any} title
 * @property {string} [id]
 * @property {string} [className]
 * @property {string} [titleClassName]
 * @property {import('react').ReactNode} [leftContent]
 * @property {import('react').ReactNode} [rightContent]
 * @property {string} [rightContentClassName]
 * @property {boolean} [dynamicRounding]
 * @property {import('react').ReactNode} [children]
 */

/** @param {HeaderCardProps} props */
export default function HeaderCard({
  title,
  id,
  className = "",
  titleClassName = "",
  leftContent,
  rightContent,
  rightContentClassName = "",
  dynamicRounding = true,
  children,
}) {
  const hasLeft = Boolean(leftContent);
  const hasRight = Boolean(rightContent) || Boolean(children);
  const hasSides = hasLeft || hasRight;

  const titleClasses = cn(
    "font-mono text-2xl font-normal tracking-tight text-center truncate min-w-0 leading-none",
    titleClassName,
  );

  // One surface (no clip/fill split): a pill header with a side icon must
  // v-center the chrome in the cap. Card's default p-5 + height clip leaves
  // extra space under leftContent.
  return (
    <Card
      padding={false}
      noHeightAnim
      className={cn(
        "border border-primary/30",
        dynamicRounding && "rounded-pill",
        className,
      )}
    >
      <div
        className={cn(
          "items-center gap-3 min-h-10",
          hasLeft ? "pl-1.5 pr-5 py-1.5" : "px-5 py-5",
          hasSides
            ? "grid grid-cols-[auto_minmax(0,1fr)_auto]"
            : "flex justify-center",
        )}
      >
        {hasSides ? (
          <>
            <div className="flex items-center justify-start self-center">
              {hasLeft ? leftContent : <span aria-hidden="true" />}
            </div>
            <h1 id={id} className={cn(titleClasses, "flex items-center justify-center")}>
              {title}
            </h1>
            <div
              className={cn(
                "flex items-center justify-end gap-3 self-center",
                rightContentClassName,
              )}
            >
              {rightContent}
              {children}
            </div>
          </>
        ) : (
          <h1 id={id} className={cn(titleClasses, "flex items-center")}>
            {title}
          </h1>
        )}
      </div>
    </Card>
  );
}
