import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Type errors fail the build: `bunx tsc --noEmit` is part of the release
  // gate (see web/README.md). A console that administers hosts does not
  // ship on a red typecheck.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
};

export default nextConfig;
