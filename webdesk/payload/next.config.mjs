import { withPayload } from '@payloadcms/next/withPayload'

// WSK-02 — this Next.js app IS the "internal listener" (design D-5, §05/WSK-D20): admin +
// Payload's generic REST catch-all + (disabled) GraphQL all live here. It must never be the
// process bound to the public vhost — see README.md "Internal vs public listener". The public
// listener is `src/public-gateway.mjs`, a separate process with no Next.js/Payload import at all.
/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
