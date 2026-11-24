#!/usr/bin/env bash
# The SDKs as they ship, from the generated cores alone: npm `withruntime` (its
# `runtime` CLI, stdio MCP bridge and drop-ins for E2B, Daytona, Vercel, Blaxel,
# Morph, Modal, Cloudflare and Fly in it), PyPI `withruntime`, the Ruby gem and
# the Go module. Nothing hand-written ships but the TypeScript CLI, its MCP
# bridge and the drop-ins (src/v2), each on the generated core.
#
# This file is the one definition of what each package holds. It never
# publishes: the SDK stage (engines/land/crates/sdks, `runtime-land-sdks`)
# writes these trees into the public mirror's copy, checks them there, and
# starts the mirror's publish workflow with a signed tag; npm, PyPI and
# RubyGems trust that workflow by OIDC, so no registry token exists anywhere.
#
#   sdks/release.sh tree SRC OUT [VERSION]   write each package's sources under OUT at the
#                                            paths the publish workflow builds (packages/cloud-sdk,
#                                            sdks/python, sdks/ruby, sdks/go), from the checkout SRC
#   sdks/release.sh check OUT [PKG...]       build those packages in OUT as their registry jobs do
#                                            (js python ruby go; all when none is named)
#                                            (a pull request's `sdk-tests` step runs tree and check for the SDKs its change files name)
#   sdks/release.sh surface OUT [PKG...]     refuse a package in OUT that breaks code written for the newest release
#                                            of its major (sdks/surface; a break needs a major change file)
#   sdks/release.sh                          both, for this checkout, into $OUT (default
#                                            /tmp/sdk-release): what a release would ship, built here
#
# A version is written once per package, at the file the release tools read it
# from (scripts/public-sdk/release/versions.ts VERSION_FILES), so the stage's
# `cli.ts set` moves each to its due version in one place.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

tree() {
  local src=$1 out=$2 v=$3
  # The version is a commit's data: X.Y.Z or nothing is written, and it never becomes part of a command.
  printf '%s\n' "$v" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' && [ "$(printf '%s' "$v" | wc -l)" -eq 0 ] ||
    { echo "release.sh: the version is not X.Y.Z" >&2; exit 2; }
  [ -f "$src/engines/front/crates/spec/openapi/v2.json" ] || { echo "release.sh: $src is not a checkout of Runtime" >&2; exit 2; }
  mkdir -p "$out"

  # npm: the core, the CLI and the MCP bridge, built by its own TypeScript 5; the API's
  # description shipped beside the CLI. server.json is the MCP registry's entry.
  local n="$out/packages/cloud-sdk"
  rm -rf "$n" && mkdir -p "$n/src"
  cp -R "$src/packages/cloud-sdk/src/generated" "$src/packages/cloud-sdk/src/v2" "$n/src/"
  cp "$src/packages/cloud-sdk/LICENSE" "$src/packages/cloud-sdk/server.json" "$n/"
  cp "$src/engines/front/crates/spec/openapi/v2.json" "$n/openapi.json"
  # Each README is spec-gen's (readme.rs), from the same surface as the code it ships beside.
  cp "$src/sdks/readme/npm.md" "$n/README.md"
  cp "$src/sdks/CHANGELOG.md" "$n/CHANGELOG.md"
  # Each `"version": "...",` line of server.json says $v; awk's program is fixed and takes the version as data.
  V=$v awk '$0 ~ /^ +"version": "[^"]*",$/ { print substr($0, 1, index($0, "\"version\": ") + 10) "\"" ENVIRON["V"] "\","; next } { print }' \
    "$n/server.json" > "$n/server.json.new" && mv "$n/server.json.new" "$n/server.json"
  cat > "$n/package.json" <<JSON
{
  "name": "withruntime",
  "version": "$v",
  "description": "Runtime Cloud: Linux sandboxes for agents. new Runtime(), a sandbox handle, every verb of the API typed, the runtime CLI, its MCP bridge and drop-ins for E2B, Daytona, Vercel, Blaxel, Morph, Modal, Cloudflare and Fly.",
  "license": "Apache-2.0",
  "type": "module",
  "mcpName": "com.withruntime/runtime",
  "exports": {
    ".": { "types": "./dist/v2/index.d.ts", "default": "./dist/v2/index.js" },
    "./e2b": { "types": "./dist/v2/shims/e2b.d.ts", "default": "./dist/v2/shims/e2b.js" },
    "./daytona": { "types": "./dist/v2/shims/daytona.d.ts", "default": "./dist/v2/shims/daytona.js" },
    "./vercel": { "types": "./dist/v2/shims/vercel.d.ts", "default": "./dist/v2/shims/vercel.js" },
    "./blaxel": { "types": "./dist/v2/shims/blaxel.d.ts", "default": "./dist/v2/shims/blaxel.js" },
    "./morph": { "types": "./dist/v2/shims/morph.d.ts", "default": "./dist/v2/shims/morph.js" },
    "./modal": { "types": "./dist/v2/shims/modal.d.ts", "default": "./dist/v2/shims/modal.js" },
    "./cloudflare": { "types": "./dist/v2/shims/cloudflare.d.ts", "default": "./dist/v2/shims/cloudflare.js" },
    "./fly": { "types": "./dist/v2/shims/fly.d.ts", "default": "./dist/v2/shims/fly.js" }
  },
  "bin": { "runtime": "dist/v2/bin.js", "withruntime": "dist/v2/bin.js" },
  "files": ["dist", "LICENSE", "README.md", "CHANGELOG.md"],
  "keywords": ["sandbox", "cloud", "agents", "ai-agents", "microvm", "firecracker", "code-execution", "code-interpreter", "mcp", "browser", "desktop", "jupyter", "ci", "serverless", "containers"],
  "scripts": {
    "build": "tsc -p tsconfig.json && chmod +x dist/v2/bin.js && cp openapi.json dist/v2/openapi.json"
  },
  "devDependencies": { "typescript": "5.9.3", "@types/node": "22.15.0" },
  "engines": { "node": ">=22.12" },
  "homepage": "https://withruntime.com",
  "repository": { "type": "git", "url": "git+https://github.com/withruntime/runtime.git", "directory": "packages/cloud-sdk" },
  "bugs": { "url": "https://github.com/withruntime/runtime/issues" },
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
}
JSON
  cat > "$n/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "lib": ["ES2022", "ESNext.Disposable", "DOM"],
    "strict": true, "noUncheckedIndexedAccess": true, "declaration": true, "outDir": "dist", "rootDir": "src",
    "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
JSON

  # PyPI: the core as the package (its signing generated with it). The integrations
  # under sdks/python/integrations are packages of their own and stay as they are.
  local p="$out/sdks/python"
  mkdir -p "$p"
  find "$p" -mindepth 1 -maxdepth 1 ! -name integrations -exec rm -rf {} +
  mkdir -p "$p/withruntime"
  cp -R "$src/sdks/python/withruntime/generated" "$p/withruntime/"
  rm -rf "$p/withruntime/generated/__pycache__"
  cp "$src/sdks/python/LICENSE" "$p/LICENSE"
  cp "$src/sdks/readme/pypi.md" "$p/README.md"
  cp "$src/sdks/CHANGELOG.md" "$p/CHANGELOG.md"
  printf 'VERSION = "%s"\n' "$v" > "$p/withruntime/_version.py"
  printf '"""Runtime Cloud: Runtime() and AsyncRuntime(), a sandbox handle, every verb of the API typed."""\n\nfrom ._version import VERSION as __version__\nfrom .generated import *  # noqa: F401,F403\nfrom .generated import __all__  # noqa: F401\n' > "$p/withruntime/__init__.py"
  cat > "$p/pyproject.toml" <<TOML
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "withruntime"
version = "$v"
description = "Runtime Cloud: Linux sandboxes for agents. The typed client for every verb of the API."
readme = "README.md"
keywords = ["sandbox", "cloud", "agents", "microvm", "firecracker", "code-execution", "mcp", "browser", "desktop", "jupyter"]
license = { text = "Apache-2.0" }
requires-python = ">=3.9"
dependencies = ["httpx>=0.27,<1"]

[project.optional-dependencies]
keypair = ["cryptography>=42"]

[project.urls]
Homepage = "https://withruntime.com"
Documentation = "https://withruntime.com/docs"
Source = "https://github.com/withruntime/runtime/tree/main/sdks/python"
Changelog = "https://github.com/withruntime/runtime/blob/main/sdks/python/CHANGELOG.md"

[tool.setuptools.packages.find]
where = ["."]
include = ["withruntime*"]
TOML

  # RubyGems: the core under lib/withruntime, signing and its errors beside it.
  local r="$out/sdks/ruby"
  rm -rf "$r" && mkdir -p "$r/lib/withruntime"
  cp -R "$src/sdks/ruby/lib/withruntime/generated" "$r/lib/withruntime/"
  cp "$src/sdks/ruby/lib/withruntime/signing.rb" "$src/sdks/ruby/lib/withruntime/errors.rb" "$r/lib/withruntime/"
  cp "$src/sdks/ruby/LICENSE" "$r/"
  cp "$src/sdks/readme/rubygems.md" "$r/README.md"
  cp "$src/sdks/CHANGELOG.md" "$r/CHANGELOG.md"
  printf '# frozen_string_literal: true\n\nmodule Withruntime\n  VERSION = "%s"\nend\n' "$v" > "$r/lib/withruntime/version.rb"
  # Withruntime::Generated is 1.0.0's name for the module its classes are in now: kept, so code written for it runs.
  printf '# frozen_string_literal: true\n\nrequire_relative "withruntime/version"\nrequire_relative "withruntime/generated/client"\n\nmodule Withruntime\n  Generated = self\nend\n' > "$r/lib/withruntime.rb"
  cat > "$r/withruntime.gemspec" <<'RUBY'
require_relative "lib/withruntime/version"

Gem::Specification.new do |spec|
  spec.name = "withruntime"
  spec.version = Withruntime::VERSION
  spec.summary = "Runtime Cloud: Linux sandboxes for agents. The typed client for every verb of the API."
  spec.authors = ["Runtime"]
  spec.homepage = "https://withruntime.com"
  spec.license = "Apache-2.0"
  spec.required_ruby_version = ">= 3.2"
  spec.files = Dir["lib/**/*.rb"] + ["LICENSE", "README.md", "CHANGELOG.md"]
  spec.metadata = {
    "homepage_uri" => "https://withruntime.com",
    "documentation_uri" => "https://withruntime.com/docs",
    "source_code_uri" => "https://github.com/withruntime/runtime/tree/main/sdks/ruby",
    "changelog_uri" => "https://github.com/withruntime/runtime/blob/main/sdks/ruby/CHANGELOG.md"
  }
end
RUBY

  # Go: the module withruntime.com/go, its core the generated package; the tag
  # v<version> on withruntime/go publishes it.
  local g="$out/sdks/go"
  rm -rf "$g" && mkdir -p "$g"
  cp -R "$src/sdks/go/generated" "$g/"
  rm -f "$g/generated/live_test.go"
  cp "$src/sdks/go/LICENSE" "$g/"
  cp "$src/sdks/readme/go.md" "$g/README.md"
  cp "$src/sdks/CHANGELOG.md" "$g/CHANGELOG.md"
  # sdks/go/go.mod is the module path's one home (the stage refuses a Go version whose major it does not match).
  local module; module=$(sed -n 's/^module //p' "$src/sdks/go/go.mod")
  cp "$src/sdks/go/go.mod" "$g/go.mod"
  printf '// Package withruntime is Runtime Cloud'"'"'s Go module; its client is the package\n// %s/generated.\npackage withruntime\n\n// Version is this module'"'"'s release.\nconst Version = "%s"\n' "$module" "$v" > "$g/client.go"
  say "trees of $v written under $out"
}

check() {
  local out=$1; shift
  local pkgs=("$@"); [ ${#pkgs[@]} -gt 0 ] || pkgs=(js python ruby go)
  local p
  for p in "${pkgs[@]}"; do
    case $p in
      # As the npm job builds it: the mirror's workspace installed at its root, then the
      # package's own build; a tree with no workspace around it installs in the package.
      js) if [ -f "$out/package.json" ]; then (cd "$out" && bun install --silent >/dev/null); \
          else (cd "$out/packages/cloud-sdk" && bun install --silent >/dev/null); fi
          (cd "$out/packages/cloud-sdk" && bun run --silent build \
            && node -e 'import("./dist/v2/index.js").then(m => { if (!m.Runtime) process.exit(1) })' \
            && npm pack --silent --dry-run >/dev/null)
          say "npm withruntime $(node -p 'require(process.argv[1]).version' "$out/packages/cloud-sdk/package.json"): built" ;;
      # The wheel installed as `pip install withruntime` leaves it, on the oldest Python
      # pyproject claims: a name only 3.14's lazy annotations forgave (Union, 16 Nov) failed
      # every import on 3.9-3.13 while the newest Python's checks passed.
      python) local oldest; oldest=$(sed -n 's/^requires-python = ">=\([0-9.]*\)"$/\1/p' "$out/sdks/python/pyproject.toml")
          rm -rf /tmp/sdk-release-wheel /tmp/sdk-release-venv
          (cd "$out/sdks/python" && python3 -m pip wheel -q --no-deps -w /tmp/sdk-release-wheel . >/dev/null) \
            && uv venv -q --python "$oldest" /tmp/sdk-release-venv \
            && uv pip install -q -p /tmp/sdk-release-venv/bin/python /tmp/sdk-release-wheel/withruntime-*.whl \
            && (cd / && /tmp/sdk-release-venv/bin/python -c 'import withruntime; withruntime.Runtime; withruntime.AsyncRuntime')
          say "PyPI withruntime: wheel built, imported on Python $oldest" ;;
      ruby) (cd "$out/sdks/ruby" && gem build -q withruntime.gemspec -o /tmp/sdk-release.gem >/dev/null \
            && ruby -I lib -e 'require "withruntime"; Withruntime::Runtime or exit 1')
          say "RubyGems withruntime: gem built" ;;
      go) (cd "$out/sdks/go" && GOFLAGS=-mod=mod go vet ./... && go build ./...)
          say "Go withruntime.com/go: vet and build pass" ;;
      *) echo "release.sh: no package $p (js python ruby go)" >&2; exit 2 ;;
    esac
  done
}

# What a minor or patch release may not do: break code written for the newest release of its major. Each package
# built in OUT is compared with that release, fetched from its registry (sdks/surface): TypeScript by the checker
# (every old export must accept the new one in its place), Python and Ruby by every method's arguments, Go by
# apidiff. A package that starts a major has nothing to compare with; a break needs a `major` change file.
surface() {
  local out=$1; shift
  local pkgs=("$@"); [ ${#pkgs[@]} -gt 0 ] || pkgs=(js python ruby go)
  local w; w=$(mktemp -d)
  local p v base
  # The newest version below $1 of its major, from the registry's list on stdin (one per line).
  baseline() { python3 -c 'import sys
v = tuple(map(int, sys.argv[1].split(".")))
vs = [tuple(map(int, l.strip().lstrip("v").split("."))) for l in sys.stdin if l.strip().lstrip("v").replace(".", "").isdigit()]
c = [x for x in vs if x[0] == v[0] and x < v]
print(".".join(map(str, max(c))) if c else "")' "$1"; }
  for p in "${pkgs[@]}"; do
    case $p in
      js) v=$(node -p 'require(process.argv[1]).version' "$out/packages/cloud-sdk/package.json")
          base=$(npm view withruntime versions --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).join("\n")))' | baseline "$v")
          [ -n "$base" ] || { say "npm withruntime $v: the first of its major, nothing to compare"; continue; }
          (cd "$w" && npm pack -s "withruntime@$base" >/dev/null && mkdir -p old && tar -xzf "withruntime-$base.tgz" -C old)
          (cd "$out/packages/cloud-sdk" && node "$here/surface/ts.mjs" "$w/old/package/dist/v2/index.d.ts" ./dist/v2/index.d.ts "$w/surface.ts" \
            && cp "$w/surface.ts" ./surface-check.ts \
            && node_modules/.bin/tsc --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 \
              --lib es2022,esnext.disposable,dom surface-check.ts; r=$?; rm -f surface-check.ts; exit $r) \
            || { echo "release.sh: npm withruntime $v breaks code written for $base (above); a break needs a major change file" >&2; return 1; }
          say "npm withruntime $v: code written for $base type-checks against it" ;;
      python) v=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$out/sdks/python/pyproject.toml")
          base=$(curl -fsS https://pypi.org/pypi/withruntime/json | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["releases"]))' | baseline "$v")
          [ -n "$base" ] || { say "PyPI withruntime $v: the first of its major, nothing to compare"; continue; }
          uv venv -q "$w/py-old" && uv pip install -q -p "$w/py-old/bin/python" "withruntime==$base" \
            && uv venv -q "$w/py-new" && (cd "$out/sdks/python" && uv pip install -q -p "$w/py-new/bin/python" .) \
            && (cd / && "$w/py-old/bin/python" -I "$here/surface/python.py" > "$w/py-old.json" && "$w/py-new/bin/python" -I "$here/surface/python.py" > "$w/py-new.json") \
            && python3 "$here/surface/compare.py" "$w/py-old.json" "$w/py-new.json" \
            || { echo "release.sh: PyPI withruntime $v breaks code written for $base (above); a break needs a major change file" >&2; return 1; }
          say "PyPI withruntime $v: every method of $base takes what it took" ;;
      ruby) v=$(sed -n 's/.*VERSION = "\(.*\)"$/\1/p' "$out/sdks/ruby/lib/withruntime/version.rb")
          base=$(curl -fsS https://rubygems.org/api/v1/versions/withruntime.json | python3 -c 'import json,sys; print("\n".join(x["number"] for x in json.load(sys.stdin)))' | baseline "$v")
          [ -n "$base" ] || { say "RubyGems withruntime $v: the first of its major, nothing to compare"; continue; }
          (cd "$w" && gem fetch -q withruntime -v "$base" >/dev/null && gem unpack -q "withruntime-$base.gem" >/dev/null) \
            && ruby "$here/surface/ruby.rb" "$w/withruntime-$base/lib" > "$w/rb-old.json" && ruby "$here/surface/ruby.rb" "$out/sdks/ruby/lib" > "$w/rb-new.json" \
            && python3 "$here/surface/compare.py" "$w/rb-old.json" "$w/rb-new.json" \
            || { echo "release.sh: RubyGems withruntime $v breaks code written for $base (above); a break needs a major change file" >&2; return 1; }
          say "RubyGems withruntime $v: every method of $base takes what it took" ;;
      go) v=$(sed -n 's/^const Version = "\(.*\)"$/\1/p' "$out/sdks/go/client.go"); local module; module=$(sed -n 's/^module //p' "$out/sdks/go/go.mod")
          base=$(curl -fsS "https://proxy.golang.org/$module/@v/list" | baseline "$v")
          [ -n "$base" ] || { say "Go $module $v: the first of its major, nothing to compare"; continue; }
          GOBIN="$w/bin" go install golang.org/x/exp/cmd/apidiff@v0.0.0-20261124000051-d6646c509b6d \
            && (cd "$w" && curl -fsSL -o old.zip "https://proxy.golang.org/$module/@v/v$base.zip" && unzip -q old.zip -d old) \
            && (cd "$w/old/$module@v$base" && "$w/bin/apidiff" -w "$w/go-old.api" "$module/generated") \
            && (cd "$out/sdks/go" && "$w/bin/apidiff" -w "$w/go-new.api" "$module/generated") \
            && ! "$w/bin/apidiff" -incompatible "$w/go-old.api" "$w/go-new.api" | grep . \
            || { echo "release.sh: Go $module $v breaks code written for $base (above); a break needs a major change file" >&2; return 1; }
          say "Go $module $v: apidiff finds nothing incompatible with $base" ;;
      *) echo "release.sh: no package $p (js python ruby go)" >&2; return 2 ;;
    esac
  done
  rm -rf "$w"
}

case "${1:-}" in
  tree) shift; tree "${1:?release.sh tree SRC OUT [VERSION]}" "${2:?release.sh tree SRC OUT [VERSION]}" "${3:-$(cat "$here/VERSION")}" ;;
  check) shift; check "${1:?release.sh check OUT [PKG...]}" "${@:2}" ;;
  surface) shift; surface "${1:?release.sh surface OUT [PKG...]}" "${@:2}" ;;
  "") out="${OUT:-/tmp/sdk-release}"; rm -rf "$out"; tree "$here/.." "$out" "$(cat "$here/VERSION")"; check "$out" ;;
  *) echo "usage: sdks/release.sh [tree SRC OUT [VERSION] | check OUT [PKG...] | surface OUT [PKG...]]" >&2; exit 2 ;;
esac
