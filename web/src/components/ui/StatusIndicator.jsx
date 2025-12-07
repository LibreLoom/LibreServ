/**
 * StatusIndicator - Simplex Mono compliant status display
 * Uses SHAPES not colors to indicate status
 * 
 * - filled circle (●) = active/running/positive
 * - hollow circle (○) = inactive/stopped/neutral  
 * - pulsing = attention needed
 */

export default function StatusIndicator({ 
  status = 'inactive', // 'active' | 'inactive' | 'attention' | 'loading'
  size = 'md', // 'sm' | 'md' | 'lg'
  label,
  className = '',
}) {
  const sizes = {
    sm: 'w-2 h-2',
    md: 'w-3 h-3',
    lg: 'w-4 h-4',
  };

  const getIndicator = () => {
    switch (status) {
      case 'active':
        // Filled circle
        return (
          <span className={`
            ${sizes[size]} 
            rounded-full 
            bg-[var(--color-secondary)]
          `} />
        );
      
      case 'inactive':
        // Hollow circle
        return (
          <span className={`
            ${sizes[size]} 
            rounded-full 
            border-2 border-[var(--color-secondary)]
            bg-transparent
          `} />
        );
      
      case 'attention':
        // Hollow circle with pulse
        return (
          <span className={`
            ${sizes[size]} 
            rounded-full 
            border-2 border-[var(--color-secondary)]
            bg-transparent
            animate-pulse
          `} />
        );
      
      case 'loading':
        // Spinning indicator
        return (
          <span className={`
            ${sizes[size]} 
            rounded-full 
            border-2 border-[var(--color-secondary)]
            border-t-transparent
            animate-spin
          `} />
        );
      
      default:
        return (
          <span className={`
            ${sizes[size]} 
            rounded-full 
            bg-[var(--color-accent)]
          `} />
        );
    }
  };

  if (label) {
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        {getIndicator()}
        <span className="font-mono text-sm">{label}</span>
      </span>
    );
  }

  return (
    <span className={`inline-flex ${className}`}>
      {getIndicator()}
    </span>
  );
}
