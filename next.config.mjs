/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Stagehand and its browser client stay as Node packages instead of being bundled.
  serverExternalPackages: ["@browserbasehq/stagehand", "@browserbasehq/sdk", "playwright-core"],
  // Library guides and agent skills are bundled into lib/generated/content.ts at build time.
};

export default nextConfig;
