import { forwardRef } from 'react';

const Card = forwardRef(({ 
  children, 
  padding = 'md', // 'none' | 'sm' | 'md' | 'lg'
  variant = 'default', // 'default' | 'interactive' | 'danger'
  className = '',
  onClick,
  ...props 
}, ref) => {
  const baseStyles = `
    bg-[var(--color-primary)]
    border-2 border-[var(--color-secondary)]
    rounded-2xl
    transition-all duration-200
  `;

  const paddings = {
    none: '',
    sm: 'p-4',
    md: 'p-6',
    lg: 'p-8',
  };

  const variants = {
    default: '',
    interactive: 'cursor-pointer hover:bg-[var(--color-secondary)]/5 active:scale-[0.99]',
    danger: 'border-dashed',
  };

  return (
    <div
      ref={ref}
      onClick={onClick}
      className={`
        ${baseStyles}
        ${paddings[padding]}
        ${variants[variant]}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
});

Card.displayName = 'Card';

export default Card;
