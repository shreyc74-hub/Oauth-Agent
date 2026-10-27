import Link from "next/link";

export default function NotFound() {
  return (
    <main className="wrap">
      <div className="prose">
        <div className="eyebrow">Not found</div>
        <h1>There&apos;s no guide at this link.</h1>
        <p className="lede">It may not have been saved, or the name is different. Search for the app instead, and the agent can research it if it&apos;s new.</p>
        <p><Link className="btn primary" href="/">Search the library</Link></p>
      </div>
    </main>
  );
}
