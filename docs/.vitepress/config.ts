import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const docs = createRequire(import.meta.url)("../../scripts/docs.cjs") as typeof import("../../scripts/docs.cjs");
const read = (path: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));

interface Site {
  title: string;
  description: string;
  sidebar: { text: string; items: { text: string; link: string }[] }[];
}

const site = read("./site.json") as Site;
const version = docs.docsVersion(read("../../package.json"));

export default defineConfig({
  title: site.title,
  description: site.description,
  base: docs.siteBase(process.env.DOCS_BASE),
  cleanUrls: true,
  outDir: fileURLToPath(new URL("../../node_modules/.cache/docs/site", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../node_modules/.cache/docs/vite", import.meta.url)),
  srcExclude: ["**/.compound-engineering/**", "**/.private/**"],
  themeConfig: {
    nav: [{ text: `v${version}`, link: "/" }],
    sidebar: site.sidebar,
    outline: { level: [2, 3] },
  },
});
