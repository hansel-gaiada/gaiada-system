import type { Metadata } from "next";
import "@/styles/globals.css";
import { getPrefs } from "@/lib/prefs";

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
  return (
    <html lang="en" data-theme={theme === "auto" ? undefined : theme}>
      <body>
        {/* Both faces are needed for first paint (display for the H1, body for
            everything else), so preload them instead of letting the browser
            discover them through the stylesheet. React hoists these into
            <head> — declaring a literal <head> here would displace the script
            tags Next injects. Fonts always fetch in CORS mode, hence
            crossOrigin even though these are same-origin. */}
        <link rel="preload" href="/fonts/Inter-Variable-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/CormorantGaramond-Variable-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
        {children}
      </body>
    </html>
  );
}
