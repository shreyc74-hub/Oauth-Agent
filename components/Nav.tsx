"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Nav() {
  const p = usePathname() || "/";
  const cur = (href: string) => (href === "/" ? p === "/" || p.startsWith("/guides") : p.startsWith(href)) ? "page" : undefined;
  return (
    <nav aria-label="Main">
      <Link href="/" aria-current={cur("/")}>Library</Link>
      <Link href="/how-it-works" aria-current={cur("/how-it-works")}>How it works</Link>
      <Link href="/ask" className="cta">Ask the agent</Link>
    </nav>
  );
}
