/** @type {import('next').NextConfig} */

/**
 * Node built-ins that the instrumentation compilation fails to resolve.
 *
 * Next compiles `instrumentation.ts` for a target without the Node presets, so
 * `node:fs`, `node:crypto` and friends come back as "UnhandledScheme". Because
 * the bootstrap imports the database, that compilation pull in `core/ids.ts`
 * (node:crypto), `db/connection` (node:fs, node:sqlite) and the job worker, and
 * the resulting failure takes the whole server down with it: the process looks
 * healthy and answers every request with a 500.
 *
 * The whole application runs on the Node server (`runtime = "nodejs"` on the
 * API route), so resolving these as runtime requires is correct.
 */
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "querystring",
  "sqlite",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

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
  /**
   * `serverExternalPackages` above keeps these parsers out of the server bundle,
   * but not out of the instrumentation compilation, where Node built-ins cannot
   * be resolved. `adm-zip` is the one that breaks it — it is CommonJS and does
   * `require("path")` at load — and an unresolved instrumentation bundle makes
   * every request fail while the server itself looks healthy.
   *
   * They are only ever reached through a lazy `import()` inside a function that
   * runs on the Node server, so leaving them as runtime requires is correct.
   */
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(config.externals ?? []),
        ({ request }, callback) => {
          if (typeof request !== "string" || request.length === 0) return callback();
          if (request.startsWith("node:") || NODE_BUILTINS.has(request)) {
            return callback(null, `commonjs ${request}`);
          }
          return callback();
        },
        "adm-zip",
        "mammoth",
        "pdfjs-dist",
      ];
    }
    return config;
  },
};

export default nextConfig;
