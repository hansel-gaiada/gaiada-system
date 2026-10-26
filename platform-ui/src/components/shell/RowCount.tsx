// The count after a row's label (DW-8m), shared by the sidebar's rows and the More panel's (SCP-Kd). `role="img"` gives it the one accessible name,
// "3 waiting for you", in place of the bare digits; it is a `<b>`, not a `<span>`, so the collapsed rail (which hides every row `span`) keeps it,
// drawn as a dot-sized pill on the icon. Past 99 the figure reads "99+" and the name still says the real count.
export function RowCount({ count, label, className = "ws-row__count", id }: { count: number; label?: string; className?: string; id?: string }) {
  return (
    <b className={className} id={id} role="img" aria-label={label ?? `${count} waiting for you`}>
      {count > 99 ? "99+" : count}
    </b>
  );
}
