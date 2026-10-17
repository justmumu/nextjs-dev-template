import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The canonical AGENTS.md carries the Next.js docs guidance; `next dev` must not rewrite it.
  agentRules: false,
  typedRoutes: true,
};

export default nextConfig;
