import { withPayload } from '@payloadcms/next/withPayload'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // WSK-00 spike: no telemetry, no image optimisation dependency needed (no upload collection).
  images: { unoptimized: true },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
