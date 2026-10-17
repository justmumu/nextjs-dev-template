# Provenance of the shared tooling

The shared development tooling of this project (the command dispatchers, the protected-files guard, the Git
hooks, the agent policy and the documentation of how they work) derives from
[justmumu/python-dev-template](https://github.com/justmumu/python-dev-template) at revision
`7f8da69c6f9f69e4fc4d1547c712fb8ef1f1d0b7`. Its behavior was carried over and reimplemented in JavaScript for
the Node and pnpm ecosystem; no Python source file is shipped or executed. The Compound Engineering configuration and license notice are retained from the source. The source is MIT licensed,
Copyright (c) 2026 justmumu, and its complete license notice is in `LICENSE` next to this file.

The generator that produced this project is
[justmumu/nextjs-dev-template](https://github.com/justmumu/nextjs-dev-template). Changing the project's name,
owner or description does not remove this attribution, and the notice must stay with any copy of the tooling.
`tooling/upstream-policy.json` in the generator maps each carried behavior to the tests that prove it.
