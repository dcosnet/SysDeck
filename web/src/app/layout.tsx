import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/sysdeck/query-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SysDeck",
  description:
    "SysDeck — every domain module behind one dashboard at dcos.net. Signed in with your Unix account (host PAM, the Cockpit way); detects every installed cockpit module — distro (machines, podman, networking, storage) and addon alike — and loads it into the console. Containers, firewall, integrity, mesh, vaults, fleet, Kata, firmware, image building, Fester DAG orchestration, the klanker-gate AI gateway and more.",
  keywords: [
    "SysDeck",
    "system dashboard",
    "Linux operations",
    "Cockpit",
    "Fester",
    "DAG builds",
    "monitoring",
  ],
  authors: [{ name: "Jeremy Anderson", url: "https://dcos.net" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
