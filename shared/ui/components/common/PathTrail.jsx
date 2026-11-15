import { Fragment } from "react";
import PropTypes from "prop-types";
import { ChevronRight } from "lucide-react";
import { ICON_SIZE } from "../../lib/ui-tokens.js";
import { cn } from "../../lib/utils";

/**
 * PathTrail — the one way to point someone to a place in the app:
 * `Settings › About › Advanced`, with a drawn chevron between the steps.
 *
 * Use it in every sentence that sends a person somewhere ("Add your token in
 * <PathTrail steps={["Settings", "About", "Advanced"]} />."). Never type
 * `→`, `>` or `›` between steps. It inherits the surrounding text color, so
 * it works on any surface.
 *
 * @param {object} props
 * @param {string[]} props.steps Each place to go, in order.
 * @param {string} [props.className]
 */
export default function PathTrail({ steps, className = "" }) {
  return (
    <span
      data-slot="path-trail"
      className={cn("inline-flex flex-wrap items-baseline gap-1", className)}
    >
      {steps.map((step, index) => (
        <Fragment key={`${index}-${step}`}>
          {index > 0 && (
            <ChevronRight
              size={ICON_SIZE.xs}
              aria-hidden="true"
              className="shrink-0 translate-y-px"
            />
          )}
          <span>{step}</span>
        </Fragment>
      ))}
    </span>
  );
}

PathTrail.propTypes = {
  steps: PropTypes.arrayOf(PropTypes.string).isRequired,
  className: PropTypes.string,
};
