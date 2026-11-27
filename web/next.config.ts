import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false, // stops `next dev` writing an AGENTS.md file into this folder
  devIndicators: false, // the framework's own badge would sit on top of the page during development
  // web/ stands alone: nothing outside this folder is read at build time
  turbopack: { root: path.resolve(__dirname) },
};

export default config;
