import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StellaBox",
  description: "A passkey-secured Stellar smart account with bounded agent budgets.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
