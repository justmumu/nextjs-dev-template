# Prerequisites and platforms

## Prerequisites

| Tool | Version                       | Why it is needed                                                                                           |
| ---- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Node | 24.21.0, exactly              | Every script, the guard and the Git hooks; pinned in `.node-version` and `engines.node`                    |
| pnpm | 12.14.0, exactly              | Installs and runs the scripts; pinned in `packageManager`                                                  |
| Git  | 2.34 or newer                 | History, hooks, worktrees and the template update; 2.34 is the oldest release the update was verified with |
| file | the operating system's `file` | The documentation link checker identifies extensionless pages with `file -b --mime-type`                   |

JavaScript-only tooling does not mean Git is unnecessary: creation, hooks, updates and releases all use it.
`file` is part of most Linux and macOS systems; minimal container images often lack it. No Python, uv,
Copier, MkDocs, Make or Python-based hook is needed anywhere.

The Linux production tests (`pnpm run test:e2e`, `pnpm run test:artifact`) additionally need the `unshare`
and `ip` commands and a usable user and network namespace, because they prove the build and the standalone
artifact offline. Some distributions restrict unprivileged user namespaces (Ubuntu 24.04 does through
AppArmor); CI lifts that restriction for its job. The browsers are installed separately with the Playwright
command the CI workflow shows.

## Supported platforms

| Platform                                           | Status                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Linux x64                                          | Covered by CI (Ubuntu 24.04) and by the no-Python acceptance image                                                 |
| Linux ARM64                                        | Exercised by maintainers locally, including the no-Python acceptance image; not covered by CI                      |
| macOS on Apple silicon                             | Infrastructure scenarios only in CI: launcher, hooks, paths, mutex and repair; no browsers                         |
| WSL2, on the distribution's Linux filesystem       | Supported by contract; a WSL2 smoke receipt is required before a release, and a hosted Linux run is not a WSL test |
| Native Windows, NFS and other network file systems | Not supported                                                                                                      |

Chromium (desktop and mobile viewport) and a WebKit smoke are the browsers; no other browser or
architecture is supported. A result on one platform is not evidence for another.

## What these limits mean for the guard

The guard's state files, its locks and the Git hooks rely on a local filesystem with exclusive file creation
and atomic rename. That is why network file systems are outside the contract.
