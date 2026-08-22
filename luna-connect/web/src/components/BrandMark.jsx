/** Plug mark copied from LibreServ Connect favicons. */
export function BrandMark({ className = "h-8 w-8", title = "Luna Connect" }) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      title={title}
      className={`${className} rounded-large-element`}
    />
  );
}
