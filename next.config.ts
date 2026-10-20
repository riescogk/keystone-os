import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: "55mb",
    serverActions: {
      // Must be >= MAX_FILE_SIZE_BYTES in src/lib/reports/validation.ts.
      // Kept slightly above that limit so our own validation error
      // message (not a generic framework error) is what the user sees
      // when a file is too large.
      bodySizeLimit: "55mb",
    },
  },
};

export default nextConfig;