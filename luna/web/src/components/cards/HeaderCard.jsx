import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import Card from "./Card";

const alignmentClasses = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/**
 * @typedef {object} HeaderCardProps
 * @property {any} title
 * @property {string} [id]
 * @property {string} [align]
 * @property {string} [className]
 * @property {string} [titleClassName]
 * @property {import('react').ReactNode} [leftContent]
 * @property {import('react').ReactNode} [rightContent]
 * @property {string} [rightContentClassName]
 * @property {import('react').ReactNode} [bottomContent]
 * @property {string} [bottomContentClassName]
 * @property {boolean} [dynamicRounding]
 * @property {import('react').ReactNode} [children]
 */

/** @param {HeaderCardProps} props */
export default function HeaderCard({
  title,
  id,
  align = "center",
  className = "",
  titleClassName = "",
  leftContent,
  rightContent,
  rightContentClassName = "",
  bottomContent,
  bottomContentClassName = "",
  dynamicRounding = true,
  children,
}) {
  const [isMultiline, setIsMultiline] = useState(false);
  const [titleElements, setTitleElements] = useState([]);

  const addTitleRef = useCallback(
    (el) => {
      if (el && !titleElements.includes(el)) {
        setTitleElements((prev) => [...prev, el]);
      }
    },
    [titleElements],
  );

  useEffect(() => {
    if (titleElements.length === 0) return;

    const checkMultiline = () => {
      for (const el of titleElements) {
        if (el.offsetHeight > 0) {
          const style = window.getComputedStyle(el);
          const lineHeight = parseFloat(style.lineHeight);
          const actualHeight = el.offsetHeight;
          setIsMultiline(actualHeight > lineHeight * 1.4);
          return;
        }
      }
    };

    const timeoutId = setTimeout(checkMultiline, 50);
    const observer = new ResizeObserver(checkMultiline);
    titleElements.forEach((el) => observer.observe(el));
    window.addEventListener("resize", checkMultiline);

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
      window.removeEventListener("resize", checkMultiline);
    };
  }, [titleElements, title]);

  const hasBottomContent =
    bottomContent != null &&
    (typeof bottomContent !== "string" || bottomContent.trim().length > 0);

  const hasLeft = Boolean(leftContent);
  const hasRight = Boolean(rightContent) || Boolean(children);
  const hasExtras = hasLeft || hasRight || hasBottomContent;

  const alignmentClass = alignmentClasses[align] || alignmentClasses.center;
  const responsiveAlignmentClass = alignmentClass.replace("text-", "sm:text-");

  const needsGrid = hasLeft || hasRight;

  const contentLayout = needsGrid
    ? "flex flex-col items-center gap-3 sm:grid sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-4"
    : "flex flex-col items-center gap-2 sm:flex sm:flex-row sm:items-center sm:justify-center";

  const baseCardClass = "border border-primary/30 transition-all duration-300 ease-in-out";
  const titleCardClass = cn(baseCardClass, className);
  const titleClasses = cn(
    "font-mono text-2xl font-normal tracking-tight text-center",
    responsiveAlignmentClass,
    titleClassName
  );

  if (hasExtras) {
    return (
      <>
        {/* Mobile layout */}
        <div className="flex flex-col gap-3 xl:hidden">
          <Card
            className={cn(titleCardClass, dynamicRounding && !isMultiline && "rounded-pill")}
          >
            <div className="flex items-center justify-center">
              <h1 ref={addTitleRef} id={id} className={titleClasses}>
                {title}
              </h1>
            </div>
          </Card>

          {hasLeft && (
            <Card className={baseCardClass}>
              <div className="flex items-center justify-center text-center">
                {leftContent}
              </div>
            </Card>
          )}

          {hasRight && (
            <Card className={baseCardClass}>
              <div
                className={cn("flex items-center justify-center gap-3 text-center", rightContentClassName)}
              >
                {rightContent && (
                  <div className="flex items-center">{rightContent}</div>
                )}
                {children}
              </div>
            </Card>
          )}

          {hasBottomContent && (
            <Card className={baseCardClass}>
              <div className={bottomContentClassName}>{bottomContent}</div>
            </Card>
          )}
        </div>

        {/* Desktop layout */}
        <div className="hidden xl:block">
          <Card
            className={cn(titleCardClass, dynamicRounding && !isMultiline && "rounded-pill")}
          >
            <div className={contentLayout}>
              {hasLeft ? (
                <div className="flex items-center justify-center text-center sm:justify-start sm:text-left">
                  {leftContent}
                </div>
              ) : hasRight ? (
                <div aria-hidden="true" className="hidden sm:block" />
              ) : null}

              <h1 ref={addTitleRef} id={id} className={titleClasses}>
                {title}
              </h1>

              {hasRight && (
                <div
                  className={cn(
                    "flex w-full items-center justify-center gap-3 text-center",
                    "sm:w-auto sm:justify-end sm:text-right",
                    rightContentClassName
                  )}
                >
                  {rightContent && (
                    <div className="flex items-center">{rightContent}</div>
                  )}
                  {children}
                </div>
              )}
            </div>

            {hasBottomContent && (
              <>
                <div
                  className="my-6 h-px w-full bg-accent/60"
                  aria-hidden="true"
                />
                <div className={bottomContentClassName}>
                  {bottomContent}
                </div>
              </>
            )}
          </Card>
        </div>
      </>
    );
  }

  return (
    <Card
      className={cn(titleCardClass, dynamicRounding && !isMultiline && "rounded-pill")}
    >
      <div className={contentLayout}>
        <h1 ref={addTitleRef} id={id} className={titleClasses}>
          {title}
        </h1>
      </div>
    </Card>
  );
}
