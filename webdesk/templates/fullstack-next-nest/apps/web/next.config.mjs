// WEBDESK_STATIC_EXPORT=1 is set by the deploy workflow (.github/workflows/site.yml, kind: fullstack): `next build` then writes a
// fully static site to apps/web/out, which deploys like a static site (WSK-D79, O-6 option A: the web half is a static export,
// the API half runs on a Node host, M6-P6l). Without it the app builds for `next start` as before, so local dev is unchanged.
// A page that renders per request (`export const dynamic = "force-dynamic"`, or reading cookies/headers) cannot be exported:
// next build says so and the workflow's build job fails; such a page needs generateStaticParams / static data instead.
// The pages code.scaffold generates already do (M6-P6m): they read content through the SDK at build time.
const staticExport = process.env.WEBDESK_STATIC_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(staticExport ? { output: "export", trailingSlash: true, images: { unoptimized: true } } : {}),
};
export default nextConfig;
