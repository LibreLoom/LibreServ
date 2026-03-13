import { Link } from "react-router-dom";

const variants = {
  default:
    "bg-primary text-secondary hover:bg-secondary hover:text-primary hover:ring-primary mt-5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
  inverted:
    "bg-secondary text-primary hover:bg-primary hover:text-secondary hover:ring-secondary mt-0 py-4 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
  danger:
    "bg-accent text-primary hover:bg-primary hover:text-accent hover:ring-accent mt-0 py-4 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
};

export default function CardButton({
  action,
  actionLabel = "View All",
  variant = "default",
  className = "",
  external = false,
}) {
  // Map visual intent to a Tailwind class bundle.
  const variantClasses = variants[variant] || variants.default;

  if (external) {
    return (
      <a
        href={action}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={actionLabel}
        className={`flex items-center justify-center rounded-pill p-2 motion-safe:transition-all hover:ring-2 hover:ring-solid cursor-pointer ${variantClasses} ${className} h-full w-full`}
      >
        <span className="text-sm font-medium">{actionLabel}</span>
      </a>
    );
  }

   return (
     <Link
       to={action}
       aria-label={actionLabel}
       className={`flex items-center justify-center rounded-pill p-2 motion-safe:transition-all hover:ring-2 hover:ring-solid cursor-pointer ${variantClasses} ${className} h-full w-full`}
     >
       <span className="text-sm font-medium">{actionLabel}</span>
     </Link>
   );
}
