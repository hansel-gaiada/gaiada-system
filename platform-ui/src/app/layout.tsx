import type { Metadata } from "next";
import "@/styles/globals.css";
import { getPrefs, getSidebarState } from "@/lib/prefs";

export const metadata: Metadata = {
  title: "Syrowatka — Operating Platform",
  description: "The D & A Syrowatka operating platform for all companies and departments.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The appearance preference has to land on <html> so it also covers the routes
  // outside the app shell (login, step-up, not-found). "auto" sets no attribute
  // at all, which hands the decision to the prefers-color-scheme block in
  // tokens/colors.css.
  const { theme } = await getPrefs();
  // Stamped server-side so a collapsed sidebar never flashes open on first paint.
  const sidebar = await getSidebarState();
  return (
    <html lang="en" data-theme={theme === "auto" ? undefined : theme} data-sidebar={sidebar === "collapsed" ? "collapsed" : undefined}>
      <body>
        {/* Preloaded rather than discovered through the stylesheet, so the real
            face lands before first paint. React hoists these into <head> —
            declaring a literal <head> here would displace the script tags Next
            injects. Fonts always fetch in CORS mode, hence crossOrigin even
            though these are same-origin.

            Gold-glass (2026-08-30): the Cormorant Garamond preload is gone with
            the serif itself (owner decision 1). Inter is now the only face the
            app actually uses — --font-display resolves to it as a documented
            interim until Urbanist's woff2 files are committed; see the blocked
            note in styles/tokens/fonts.css. Add the Urbanist preload back HERE
            in the same change that adds those files, or the display face will
            arrive a paint late on every route. The orphaned
            /public/fonts/CormorantGaramond-*.woff2 are no longer referenced by
            anything and can be deleted. */}
        <link rel="preload" href="/fonts/Inter-Variable-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
        {children}
      </body>
    </html>
  );
}
