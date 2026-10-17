import styles from "./page.module.css";

export default function HomePage() {
  return (
    <section className={styles.hero} aria-labelledby="home-title">
      <h1 id="home-title">Your application starts here</h1>
      <p>
        This is a minimal Next.js App Router project. Replace this page with your own, and read the{" "}
        <a href="https://nextjs.org/docs" rel="noreferrer">
          Next.js documentation
        </a>{" "}
        when you need a guide.
      </p>
    </section>
  );
}
