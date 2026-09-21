import IconCircle from "../ui/IconCircle";
import Card from "./Card";
import PropTypes from "prop-types";

/**
 * @param {{ icon?: any, title?: any, subtitle?: any, children?: any, actions?: any, className?: string }} _
 */
export default function BaseCard({
  icon: Icon,
  title,
  subtitle,
  children,
  actions,
  className = "",
}) {
  return (
    <Card padding={false} className={className} data-slot="base-card">
      {(Icon || title) && (
        <>
          <div className="flex items-center gap-4 mb-4 p-5 pb-0">
            {Icon && <IconCircle icon={Icon} size="lg" />}
            <div className="text-left">
              {title && <div className="font-semibold">{title}</div>}
              {subtitle && <div className="text-sm text-accent">{subtitle}</div>}
            </div>
          </div>
          <div className="h-1 bg-primary rounded-pill mx-5 mb-4" aria-hidden="true" />
        </>
      )}
      <div className="p-5">
        {children}
        {actions && <div className="mt-4">{actions}</div>}
      </div>
    </Card>
  );
}

BaseCard.propTypes = {
  icon: PropTypes.elementType,
  title: PropTypes.string,
  subtitle: PropTypes.string,
  children: PropTypes.node,
  actions: PropTypes.node,
  className: PropTypes.string,
};