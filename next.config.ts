import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a wasm build that must not be bundled by the server compiler.
  serverExternalPackages: ["@electric-sql/pglite"],
  agentRules: false,
};

export default nextConfig;
