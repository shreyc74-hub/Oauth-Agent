import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "OAuth Readiness Guides",
  description: "How long until your users can connect? OAuth app setup and approval guides for agent builders on Composio, with a research agent for apps not in the library.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" />
      </head>
      <body>
        <header className="site">
          <div className="wrap">
            <Link href="/" className="brand"><b>OAuth Readiness</b><span>for agent builders on Composio</span></Link>
            <Nav />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
