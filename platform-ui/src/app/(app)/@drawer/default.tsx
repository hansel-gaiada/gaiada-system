// Nothing in the drawer slot by default. Required by Next: without a `default` export for a parallel
// slot, a hard navigation (or a refresh on any page) has no state to render for that slot and 404s.
export default function DrawerDefault() {
  return null;
}
