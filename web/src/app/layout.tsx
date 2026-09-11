import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
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
  title: "SysDeck — Web Edition",
  description:
    "SysDeck v0.2.0 — twenty-six domain modules behind one dashboard. Containers, firewall, integrity, mesh, vaults, fleet, Kata, firmware, image building, Fester DAG orchestration and more.",
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
        <Toaster />
      </body>
    </html>
  );
}
