# Changelog

Every release of the Runtime Cloud SDKs: npm `withruntime`, PyPI `withruntime`, RubyGems `withruntime` and the Go
module `withruntime.com/go`. Versions follow [Semantic Versioning](https://semver.org). Each release is generated from
the API's OpenAPI description, `https://api.withruntime.com/v2/openapi.json`.

## 1.1.1 (24 November 2026), npm

### Fixed

- `npx withruntime <command>` runs the command. In 1.0.0 and 1.1.0 it exited at once with no output, because the CLI
  ran only when started under the name `runtime`; `npx withruntime login`, `npx withruntime mcp` and every other
  command did nothing. The `runtime` command was not affected.

## 1.1.0 (24 November 2026), and Go v2.0.0

npm, PyPI and RubyGems `withruntime` 1.1.0. The Go module moves to `withruntime.com/go/v2` at v2.0.0: import
`withruntime.com/go/v2/generated`. In Go, `Get` and `Refresh` of domains, images, jobs, job runs, previews,
secrets, snapshots and volumes take a query (`wait`, `ifState`) before the request options, and `Volumes.Create`,
`Volumes.Get` and `Snapshots.Get` return `*Volume` and `*Snapshot` handles. `withruntime.com/go` v1.0.0 stays
available.

### Added

- `Sandbox.create()` and the same class method on every product (`App.create()`, `Browser.create()` and so on) in
  TypeScript and Python. Each returns a handle with a client of its own.
- `await using` (TypeScript) and `with` / `async with` (Python) delete a machine when the block ends.
- `spawn` on every machine, in TypeScript and Python: start a background process and read its output later.
- `processes.resize` and `resizeProcess` on every machine: resize the terminal of a process started with a pty.
- `update` on images, snapshots and volumes.
- `runtime.projects.limits`: read and set a project's limits. `Project` carries `limits`.
- `runtime.roles.actions`: add or remove a role's actions. `KeyCreate` takes `actions`.
- Machines: `autoWake`, `deleteAfterSeconds` and `deleteProtection` on create, update and fork; `from` on create;
  `pausedAt`, `deleteAt` and `deleteProtection` on the machine.
- Images: `pullSecret` (a registry login), `deleteAfterSeconds` and `deleteProtection`. Volumes and snapshots take
  `deleteAfterSeconds` and `deleteProtection`.
- `wait` and `ifState` on `get` and `refresh` of domains, images, jobs, job runs, previews, secrets, snapshots and
  volumes: wait for a change instead of polling.
- Previews: `sandbox.previews.create()`, and `name`, the preview's hostname, which its own calls also take.
- Secrets: `scope.none`, a secret only Runtime uses (for example an image's `pullSecret`).
- Usage: `hours`, `keys` and `lines` break usage down by hour, API key and product line.
- `RUNTIME_PROJECT` (or the `project` option) scopes every call, with a bearer key as well as a key pair.
- Typed `Volume` and `Snapshot` handles from `volumes.create`, `volumes.get` and `snapshots.get`.
- `CardRequiredError` and `MethodNotAllowedError` (TypeScript, Python).
- A README in every package, and this changelog.

### Fixed

- The `runtime` CLI sends number flags such as `--memory-gb 16` as numbers; 1.0.0 sent them as text, which the API
  refused. One `--cmd` is a shell command line, run by `bash -lc`.
- `runtime --help` and other long output are no longer cut off at 64 KiB when piped on macOS.
- `runtime mcp` answers a refused call (no key, a bad key, a limit) with a JSON-RPC error for that request, instead
  of the API's error body, which MCP clients could not read.

- Every handle answers its record's fields as its own (`volume.sizeBytes`, `snapshot.name`), so `volumes.get`,
  `volumes.create` and `snapshots.get`, which now return handles with `refresh`, `update` and `delete`, still answer
  everything the record had. Every handle keeps `id` where its key is another field (`preview.name`).
- The query argument of every method also takes the request options, so a call written before the method had a
  query, such as `domains.get(hostname, { signal })`, keeps working (TypeScript).

### Compatibility

Code written for 1.0.0 runs unchanged in TypeScript, Python and Ruby (Go: see above), with two exceptions for code that builds the
SDK's own records: Python's record classes take their fields by keyword (new fields are not added at the end), and
in Ruby, `Domain`, `Job`, `Preview`, `Sandbox` and `Secret` are handles now, which read their fields but no longer
have a Struct's setters, `to_wire` or `.from`; their records are `DomainInfo`, `JobInfo`, `PreviewInfo`,
`SandboxInfo` and `SecretInfo`. `Withruntime::Generated::` names still resolve.

Python 1.0.0 raised `KeyError: 'labelsAny'` reading a secret whose scope is `none` (an image's `pullSecret`); 1.1.0
reads it.

## 1.0.0 (17 November 2026)

The first release generated from the API's description: every product and every operation of
`https://api.withruntime.com/v2`, typed, in TypeScript, Python, Ruby and Go, with the `runtime` CLI and its MCP server
in the npm package. It replaces the hand-written 0.x SDKs, which called the v1 API.
