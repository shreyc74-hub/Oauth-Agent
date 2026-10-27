import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "OAuth Readiness Guides",
  description: "How long until your users can connect? OAuth app setup and approval guides for agent builders on Composio.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://rsms.me/" />
        <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
      </head>
      <body>
        <div className="shell">
          <header className="top">
            <Link href="/" className="brand"><b>OAuth Readiness</b><span>for agent builders on Composio</span></Link>
            <nav aria-label="Main">
              <Link href="/">Library</Link>
              <Link href="/how-it-works">How it works</Link>
            </nav>
          </header>
          <main>{children}</main>
          <footer className="foot">Guides marked Tested were checked by creating a real app. Generated guides come from the research agent and say how sure they are about each claim.</footer>
        </div>
      </body>
    </html>
  );
}
