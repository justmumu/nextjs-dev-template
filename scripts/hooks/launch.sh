#!/bin/sh
# Starts the protected-files guard with the Node binary bound to this machine at setup. It runs
# before any Node code, so the environment that could change what Node loads is cleared here, not
# inside the guard: every NODE_* variable (NODE_OPTIONS preloads, NODE_PATH, compile caches) is
# dropped, and the binary is never looked up on PATH or under the project's dependencies.
set -u

code=2
for argument in "$@"; do
  [ "$argument" = "stop" ] && code=1
done

refuse() {
  printf 'Protected-files guard cannot start: %s\n' "$1" >&2
  exit "$code"
}

here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || refuse "its own location is unreadable"
root=$(CDPATH= cd -- "$here/../.." 2>/dev/null && pwd -P) || refuse "the project root is unreadable"

for name in $(env | sed -n 's/^\(NODE_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || refuse "this is not a Git worktree"
binding="$common/protected-baseline-node"
[ -f "$binding" ] || refuse "no Node binary is bound; run node scripts/bootstrap.cjs setup"
IFS= read -r node < "$binding" || refuse "the Node binding is unreadable"

case "$node" in
  /*) ;;
  *) refuse "the bound Node path is not absolute" ;;
esac
case "$node" in
  "$root"/*) refuse "the bound Node binary is inside the project" ;;
esac
[ -f "$node" ] && [ -x "$node" ] || refuse "the bound Node binary is missing; run node scripts/bootstrap.cjs setup"

exec "$node" --no-addons --no-global-search-paths --disable-proto=throw "$here/entry.cjs" "$@"
