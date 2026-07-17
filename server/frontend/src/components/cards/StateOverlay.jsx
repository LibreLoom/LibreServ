import Card from "./Card";
import { cn } from "@/lib/utils";

/**
 * StateOverlay — a full-viewport centered overlay used for loading and error
 * states. Replaces the hand-copied
 * `<div className="fixed inset-0 flex items-center justify-center bg-primary/60 backdrop-blur-sm"><Card>…</Card></div>`
 * pattern repeated across pages.
 *
 * @param {object} props
 * @param {import("react").ReactNode} [props.children] Content inside the card. Defaults to a status paragraph.
 * @param {string} [props.message] Shortcut: renders `<p>{message}</p>` with role="status".
 * @param {"loading"|"error"|"status"} [props.kind] Visual variant. "error" adds an accent border.
 * @param {string} [props.cardClassName] Extra classes for the inner Card.
 */
export default function StateOverlay({
  children,
  message,
  kind = "status",
  cardClassName = "",
}) {
  const role = kind === "error" ? "alert" : "status";
  return (
    <div className={cn("fixed inset-0 z-40 flex items-center justify-center bg-primary/60 backdrop-blur-sm")} data-slot="state-overlay">
      <Card className={cn("w-[70vw] sm:w-[20vw]", kind === "error" ? "border-2 border-accent" : "", cardClassName)}>
        <div className="my-5 text-center" role={role} aria-live={kind === "error" ? "assertive" : "polite"}>
          {children ?? (message ? <p>{message}</p> : null)}
        </div>
      </Card>
    </div>
  );
}