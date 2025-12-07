const StatusDot = ({ 
  status = 'neutral', // 'active' | 'inactive' | 'attention' | 'neutral'
  size = 'md', // 'sm' | 'md' | 'lg'
  className = '',
}) => {
  // Shape-based status indication (no semantic colors!)
  // - active: filled circle
  // - inactive: hollow circle  
  // - attention: hollow circle with pulse
  // - neutral: hollow circle (accent color)

  const sizes = {
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
    lg: 'w-3 h-3',
  };

  const borderSizes = {
    sm: 'border',
    md: 'border-[1.5px]',
    lg: 'border-2',
  };

  const statusStyles = {
    active: `bg-[var(--color-secondary)]`, // Filled
    inactive: `bg-transparent border ${borderSizes[size]} border-[var(--color-secondary)]`, // Hollow
    attention: `bg-transparent border ${borderSizes[size]} border-[var(--color-secondary)] animate-pulse`, // Hollow + pulse
    neutral: `bg-transparent border ${borderSizes[size]} border-[var(--color-accent)]`, // Hollow accent
  };

  return (
    <span 
      className={`
        inline-block rounded-full flex-shrink-0
        ${sizes[size]}
        ${statusStyles[status]}
        ${className}
      `}
      aria-hidden="true"
    />
  );
};

export default StatusDot;
