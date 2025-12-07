const Divider = ({ 
  orientation = 'vertical', // 'vertical' | 'horizontal'
  className = '',
}) => {
  const styles = orientation === 'vertical' 
    ? 'w-0.5 h-[80%] self-center'
    : 'h-0.5 w-full';

  return (
    <div 
      className={`
        bg-[var(--color-accent)]
        ${styles}
        ${className}
      `}
      aria-hidden="true"
    />
  );
};

export default Divider;
