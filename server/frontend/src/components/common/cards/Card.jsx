export default function Card({ children, className = "" }) {
  return (
    <div
      className={`bg-secondary text-primary rounded-large-element p-5 ${className}`}
    >
      {children}
    </div>
  );
}
