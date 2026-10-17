"use client";

// The error is intentionally not rendered: production error details belong in server logs, not on the page.
// `retry` fetches and renders the failed segment again; `reset` would only clear the error state and show the failed result again.
export default function ErrorBoundary({ retry }: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  return (
    <section role="alert" aria-labelledby="error-title">
      <h1 id="error-title">Something went wrong</h1>
      <p>The page could not be displayed. You can try again.</p>
      <button
        type="button"
        onClick={() => {
          retry();
        }}
      >
        Try again
      </button>
    </section>
  );
}
