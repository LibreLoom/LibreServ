import IconCircle from "../ui/IconCircle";
import PropTypes from "prop-types";

export default function BaseCard({
  icon: Icon,
  title,
  subtitle,
  children,
  actions,
  className = "",
}) {
  return (
    <div className={`pop-in flex-1 mx-1.25 bg-secondary text-primary rounded-3xl p-5 motion-safe:transition hover:scale-[1.02] self-start ${className}`}>
      {(Icon || title) && (
        <>
          <div className="flex items-center gap-4 mb-4">
            {Icon && <IconCircle icon={Icon} size="lg" />}
            <div className="text-left">
              {title && <div className="font-semibold">{title}</div>}
              {subtitle && <div className="text-sm text-accent">{subtitle}</div>}
            </div>
          </div>
          <div className="h-1 bg-primary rounded-pill mx-1 mb-4" aria-hidden="true" />
        </>
      )}
      
      {children}
      
      {actions && <div className="mt-4">{actions}</div>}
    </div>
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
