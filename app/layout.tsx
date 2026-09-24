import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Insta Quote AI — Assessment",
  description:
    "Upload a PDF invoice or docket; get traceable line items plus explicit refusals.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-NZ">
      <body>{children}</body>
    </html>
  );
}
