const StatusDot = ({ 
  status = 'neutral', // 'success' | 'warning' | 'error' | 'info' | 'neutral'
  size = 'md', // 'sm' | 'md' | 'lg'
  className = '',
  pulse = false,
}) => {
  const statusColors = {
    success: 'bg-green-500',
    warning: 'bg-amber-500',
    error: 'bg-red-500',
    info: 'bg-blue-500',
    neutral: 'bg-[var(--color-accent)]',
  };

  const sizes = {
    sm: 'w-1.5 h-1.5',
    md: 'w-2 h-2',
    lg: 'w-3 h-3',
  };

  return (
    <span 
      className={`
        inline-block rounded-full flex-shrink-0
        ${statusColors[status]}
        ${sizes[size]}
        ${pulse ? 'animate-pulse' : ''}
        ${className}
      `}
      aria-hidden="true"
    />
  );
};

export default StatusDot;
