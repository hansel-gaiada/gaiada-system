import { withPayload } from '@payloadcms/next/withPayload'

// WSK-02 — this Next.js app IS the "internal listener" (design D-5, §05/WSK-D20): admin +
// Payload's generic REST catch-all + (disabled) GraphQL all live here. It must never be the
// process bound to the public vhost — see README.md "Internal vs public listener". The public
// listener is `src/public-gateway.mjs`, a separate process with no Next.js/Payload import at all.
/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  // WSK-28 (2026-08-27) — required by webdesk/payload/Dockerfile, which copies
  // `/app/.next/standalone`. Without this the build emits no standalone output and the image build
  // dies at that COPY with "not found" — which is exactly what happened the first time it was
  // built for real (WSK-29 wrote the Dockerfile and honestly flagged it as unverified end-to-end).
  output: 'standalone',
  // Same reason platform-ui/next.config sets it: without an explicit tracing root Next can infer a
  // wrong workspace root and nest `.next/standalone/server.js` one directory deeper than the
  // Dockerfile expects. `__dirname` does not exist in an ESM config, hence import.meta.dirname.
  outputFileTracingRoot: import.meta.dirname,
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
