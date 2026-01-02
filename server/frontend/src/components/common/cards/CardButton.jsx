import { Link } from "react-router-dom";

export default function CardButton({
  action,
  actionLabel = "View All",
  className,
}) {
  return (
    <Link
      to={action}
      aria-label={actionLabel}
      className={`flex items-center justify-center bg-primary text-secondary rounded-pill p-2 mt-5 motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid cursor-pointer ${className}`}
    >
      <span className="text-sm font-medium">{actionLabel}</span>
    </Link>
  );
}
