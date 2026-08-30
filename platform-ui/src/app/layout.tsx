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

            Gold-glass (2026-08-30): Cormorant Garamond left the product with
            the serif (owner decision 1) and its woff2 files are deleted;
            Urbanist replaces it as --font-display. Both faces are needed for
            first paint — Urbanist for every heading, Inter for everything
            else — so both are preloaded. */}
        <link rel="preload" href="/fonts/Inter-Variable-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/Urbanist-Variable-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
        {children}
      </body>
    </html>
  );
}
