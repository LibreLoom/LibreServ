import { forwardRef } from 'react';

const Pill = forwardRef(({ 
  children, 
  className = '',
  ...props 
}, ref) => {
  return (
    <div
      ref={ref}
      className={`
        inline-flex items-center gap-2
        px-4 py-2
        border-2 border-[var(--color-secondary)]
        rounded-full
        font-mono text-sm
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
