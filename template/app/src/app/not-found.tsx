import Link from "next/link";

export default function NotFound() {
  return (
    <section aria-labelledby="not-found-title">
      <h1 id="not-found-title">Page not found</h1>
      <p>The page you asked for does not exist.</p>
      <Link href="/">Go to the home page</Link>
    </section>
  );
}
