import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tracework — Literature review workspace",
  description: "Build auditable literature-review claims from source evidence.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
