import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server and only the
  // node_modules actually reached, which is what the Docker image runs.
  // Harmless for local `pnpm dev`.
  output: "standalone",
};

export default nextConfig;
