import { Link } from "react-router-dom";

const variants = {
  default:
    "bg-primary text-secondary hover:bg-secondary hover:text-primary hover:outline-primary mt-5 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
  inverted:
    "bg-secondary text-primary hover:bg-primary hover:text-secondary hover:outline-secondary mt-0 py-4 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2",
  danger:
    "bg-accent text-primary hover:bg-primary hover:text-accent hover:outline-accent mt-0 py-4 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2",
};

export default function CardButton({
  action,
  actionLabel = "View All",
  variant = "default",
  className = "",
}) {
  // Map visual intent to a Tailwind class bundle.
  const variantClasses = variants[variant] || variants.default;

  return (
    <Link
      to={action}
      aria-label={actionLabel}
      className={`flex items-center justify-center rounded-pill p-2 motion-safe:transition-all hover:outline-2 hover:outline-solid cursor-pointer ${variantClasses} ${className} h-full w-full`}
    >
      <span className="text-sm font-medium">{actionLabel}</span>
    </Link>
  );
}
