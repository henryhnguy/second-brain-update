/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  eslint: { ignoreDuringBuilds: true },
  // Heavy pure-JS parsers are loaded on demand; keep them out of the server bundle.
  serverExternalPackages: ["pdfjs-dist", "mammoth", "adm-zip"],
  experimental: {
    // Allow ingesting reasonably large uploads through the API.
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
