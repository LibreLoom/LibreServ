/**
 * LoadingSpinner component
 * Displays a loading spinner with configurable size
 */

export default function LoadingSpinner({ size = "md" }) {
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-8 h-8", 
    lg: "w-12 h-12"
  };

  return (
    <div className="flex justify-center items-center">
      <div
        className={`${sizeClasses[size] || sizeClasses.md} animate-spin rounded-full border-2 border-gray-300 border-t-blue-600`}
        role="status"
        aria-label="Loading"
      >
        <span className="sr-only">Loading...</span>
      </div>
    </div>
  );
}
