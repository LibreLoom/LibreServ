import { forwardRef } from 'react';

const Card = forwardRef(({ 
  children, 
  className = '',
  padding = 'md', // 'sm' | 'md' | 'lg' | 'none'
  ...props 
}, ref) => {
  const paddingSizes = {
    none: '',
    sm: 'p-4',
    md: 'p-5',
    lg: 'p-6',
  };

  return (
    <div
      ref={ref}
      className={`
        bg-[var(--color-primary)]
        border-2 border-[var(--color-secondary)]
        rounded-2xl
        ${paddingSizes[padding]}
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
