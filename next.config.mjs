/** @type {import('next').NextConfig} */
const nextConfig = {
  // Part A runs pdfjs-dist server-side only; keep it out of the client bundle.
  serverExternalPackages: ["pdfjs-dist"],
  // pdfjs loads its in-process worker at runtime. Include it in the
  // serverless function trace so deployed extraction can start.
  outputFileTracingIncludes: {
    "/api/extract": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
};

export default nextConfig;
