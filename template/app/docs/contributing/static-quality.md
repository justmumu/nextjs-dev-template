# Static quality

Formatting, linting and type checking run through `pnpm run`. The project owns its configuration.

| Command                            | What it does                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run format` / `format:check` | Prettier over `**/*.{js,cjs,mjs,ts,tsx,json,css,md,yml,yaml,html}` with `.prettierrc.json` and `.prettierignore`. Lock files (`pnpm-lock.yaml`, owned by pnpm), `.compound-engineering/`, `.private/` and generated output are excluded. |
| `pnpm run lint` / `lint:fix`       | ESLint 9 flat config with `--max-warnings=0`. `lint:fix` applies ESLint's own fixes only.                                                                                                                                                |
| `pnpm run typecheck`               | `next typegen`, `tsc --noEmit` for the app, `tsc --noEmit -p tsconfig.tooling.json` for checked JavaScript tooling.                                                                                                                      |

## Strictness

- TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`.
  `checkJs` is on for the Node scripts (JSDoc types) and for the ESLint configuration.
- ESLint: `typescript-eslint` `strictTypeChecked` (typed linting), plus `eslint-config-next`
  (`core-web-vitals`) in applications. `next build` does not replace linting.
- Numbers are allowed in template literals; `any`, `undefined` and `null` are not.
- CommonJS files (`*.cjs`) may use `require()`: the Node core runs before any dependency is
  installed. That is the only rule relaxed for them. `@typescript-eslint/unbound-method` stays on, so
  a method detached from its object is an error; call `node:path` and similar functions through the
  module object (`nodePath.join(...)`) instead of destructuring them.

## Suppressions

A suppression is accepted only as

```js
// eslint-disable-next-line <rule> -- <concrete reason, at least 20 characters>
```

naming the exact rule and giving the reason (an upstream issue, a third-party limitation or an
approved architecture decision). File-wide, same-line and re-enabling directives are errors,
and so is a suppression that no longer suppresses anything. Inline configuration comments
(`/* eslint rule: "off" */`, `/* eslint-env */`) are errors as well. `@ts-ignore` and `@ts-nocheck`
are banned; `@ts-expect-error` needs a description. There is no `ignoreBuildErrors`, and no
alternative configuration may turn a gate off. A needed exception is a reviewed change to the
protected configuration.

The rules are enforced by an ESLint processor that parses each file and appends its refusals after
linting, so no comment in the file can disable them. Words that merely look like directives inside
strings, templates, regular expressions or JSX text are not directives. `lint:fix` applies the same
policy. The policy lives in `tooling/eslint/`.

## Next.js generated files and agent instructions

`next typegen` runs before the application type check, so a checkout without `.next` or
`next-env.d.ts` type-checks. Both are ignored by Git; `tsconfig.json` is complete from the start,
so `next dev`, `typegen` and `build` leave it, `next.config.ts`, `AGENTS.md` and `CLAUDE.md`
byte-identical.

The template sets `agentRules: false`. With that setting `next dev` silently removes a managed
`<!-- BEGIN:nextjs-agent-rules -->` block (and the legacy `NEXT-AGENTS-MD` and feedback
blocks), which would change a protected file without review. The typecheck therefore fails
when `AGENTS.md` or `CLAUDE.md` contains one: move the guidance you want into the hand-written
text outside any marker, delete the block in a reviewed change, and keep the flag.
`experimental.agentFeedback` is a separate option and is not enabled.
