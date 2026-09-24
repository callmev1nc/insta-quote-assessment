/** @type {import('next').NextConfig} */
const nextConfig = {
  // Part A runs pdfjs-dist server-side only; keep it out of the client bundle.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
