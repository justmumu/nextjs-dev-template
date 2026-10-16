"use client";

// The error is intentionally not rendered: production error details belong in server logs, not on the page.
export default function ErrorBoundary({ reset }: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <section role="alert" aria-labelledby="error-title">
      <h1 id="error-title">Something went wrong</h1>
      <p>The page could not be displayed. You can try again.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
