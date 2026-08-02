import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server and only the
  // node_modules actually reached, which is what the Docker image runs.
  // Harmless for local `pnpm dev`.
  output: "standalone",
  images: {
    // Item icons. The only external host this app draws from, and the same one
    // it already asks for names and recipes.
    remotePatterns: [new URL("https://api.dofusdb.fr/img/items/**")],
  },
};

export default nextConfig;
