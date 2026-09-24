/** @type {import('next').NextConfig} */
const nextConfig = {
  // Part A runs pdfjs-dist server-side only; keep it out of the client bundle.
  serverExternalPackages: ["pdfjs-dist"],
  experimental: {
    // pdfjs loads its in-process "fake worker" from this file at runtime;
    // without it, serverless functions fail with "Setting up fake worker
    // failed" (the file isn't traced by default).
    outputFileTracingIncludes: {
      "/api/extract": [
        "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      ],
    },
  },
};

export default nextConfig;
