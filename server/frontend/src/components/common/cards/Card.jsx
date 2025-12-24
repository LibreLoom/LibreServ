export default function Card({ children, className = "" }) {
  return (
    <div className={`bg-secondary text-primary rounded-3xl p-5 ${className}`}>
      {children}
    </div>
  );
}
