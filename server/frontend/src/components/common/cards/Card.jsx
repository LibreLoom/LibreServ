export default function Card({ children, className = "" }) {
  return (
    <div
      // Base card styling stays consistent across pages; allow extensions via className.
      className={`bg-secondary text-primary rounded-large-element p-5 pop-in ${className}`}
    >
      {children}
    </div>
  );
}
