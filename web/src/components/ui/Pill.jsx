import { forwardRef } from 'react';

const Pill = forwardRef(({ 
  children, 
  size = 'md', // 'sm' | 'md' | 'lg'
  variant = 'default', // 'default' | 'filled'
  className = '',
  ...props 
}, ref) => {
  const baseStyles = `
    inline-flex items-center gap-2
    font-mono
    border-2 border-[var(--color-secondary)]
    rounded-full
    transition-all duration-200
  `;

  const sizes = {
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-3.5 py-1.5 text-sm',
    lg: 'px-5 py-2 text-base',
  };

  const variants = {
    default: 'bg-transparent text-[var(--color-secondary)]',
    filled: 'bg-[var(--color-secondary)] text-[var(--color-primary)]',
  };

  return (
    <span
      ref={ref}
      className={`
        ${baseStyles}
        ${sizes[size]}
        ${variants[variant]}
        ${className}
      `}
      {...props}
    >
      {children}
    </span>
  );
});

Pill.displayName = 'Pill';

export default Pill;
