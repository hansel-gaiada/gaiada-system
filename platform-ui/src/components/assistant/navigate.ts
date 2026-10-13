// DW-2h — the one place the assistant replaces the current history entry with a hard navigation. A module of its
// own so a test can stand in for it (jsdom's `location.replace` cannot be spied on).
export function replaceLocation(href: string): void {
  window.location.replace(href);
}
