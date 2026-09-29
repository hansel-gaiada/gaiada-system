export function Breadcrumb({ items }: { items: string[] }) {
  return (
    <div className="cc-crumb">
      {items.map((it, i) => (
        <span key={i}>{it}</span>
      ))}
    </div>
  );
}
