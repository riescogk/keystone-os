import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keystone OS",
  description: "A second reader for your finished appraisal reports.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
