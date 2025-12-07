import { forwardRef } from 'react';

const Pill = forwardRef(({ 
  children, 
  className = '',
  size = 'md', // 'sm' | 'md'
  ...props 
}, ref) => {
  const sizes = {
    sm: 'px-3 py-1 text-xs',
    md: 'px-4 py-1.5 text-sm',
  };

  return (
    <div
      ref={ref}
      className={`
        inline-flex items-center gap-2
        border-2 border-[var(--color-secondary)]
        rounded-full
        font-mono
        bg-[var(--color-primary)]
        text-[var(--color-secondary)]
        ${sizes[size]}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
});

Pill.displayName = 'Pill';

export default Pill;
