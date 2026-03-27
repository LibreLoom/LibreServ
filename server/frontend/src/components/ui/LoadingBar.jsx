import { useEffect, useState } from "react";

export default function LoadingBar({ loading }) {
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setIsLoading(loading);
  }, [loading]);

  if (!isLoading) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 h-1 bg-accent loading-bar"
      role="progressbar"
      aria-label="Loading"
    >
      <div className="h-full w-1/3 bg-primary overflow-hidden">
        <div className="animate-md-bar-1 h-full bg-primary/70" />
        <div className="animate-md-bar-2 h-full bg-primary/70" />
      </div>
    </div>
  );
}
