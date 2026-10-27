/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Library guides are read from data/guides at runtime by the API routes.
  experimental: { outputFileTracingIncludes: { "/**": ["./data/guides/**"] } },
};

export default nextConfig;
