# Offline compatibility oracle

These checks execute the pinned official E2B, Daytona, Vercel and Blaxel SDK code and Runtime's adapters against controlled fixtures. No competitor account is used. Package versions and top-level tarball integrity values must match the repository's compatibility-lock.json. The included bun.lock pins transitive dependencies too.

Run `bun run compat:oracle` from the SDK package. It installs the frozen dependencies into a temporary directory with lifecycle scripts disabled, runs the comparisons, and removes that directory. Set `RUNTIME_ORACLE_OFFICIAL_ROOT` to reuse an existing installation.

To prepare an installation manually, install outside the repository with lifecycle scripts disabled:

```sh
bun install --ignore-scripts --frozen-lockfile --cwd "$ORACLE_INSTALL_DIR"
```

Copy this directory's package.json and bun.lock to ORACLE_INSTALL_DIR first. Run:

```sh
RUNTIME_ORACLE_OFFICIAL_ROOT="$ORACLE_INSTALL_DIR" \
RUNTIME_ORACLE_RUNTIME_ROOT="$RUNTIME_REPOSITORY" \
bun "$ORACLE_HARNESS_DIR/run.mjs"
```

The harness replaces fetch with an in-memory fixture and refuses all other fetch, Socket.connect, tls.connect and WebSocket use before importing official SDKs. It never calls an original fetch implementation. Local Bash/Python/coreutils subprocesses and owned temporary files exercise ordinary command and file effects. All temporary directories are removed in finally blocks. Fixtures are deliberately single-process and serial.

It checks public-method behavior: file values/errors/listings, E2B output callbacks/errors/disconnect, command deadlines that leave the process running, pre-aborted file removal and unlimited watches, Daytona command/code results, Blaxel streamed results/callback order and wait validation. The E2B disconnect case includes Runtime's real native Process, Transport and NDJSON decoder with two output messages already buffered in one response.

An assertion failure exits nonzero. Each independently measured mismatch remains visible; a failed test does not stop later checks. The suite-completes checks only report that a provider suite reached its end; individual assertions determine the result.

This is evidence about client transformations and local subprocess fixtures. It does not certify undocumented vendor server behavior, actual VM isolation, scheduling, reconnect durability or complete API parity. TypeScript metadata inventories are separate and are not counted as behavior passes. The Vercel filesystem subprocess checks use the host's command tools; GNU/Linux-only behaviors need Linux fixtures before claiming exact host parity.

The guard covers only the listed JavaScript entry points. It is not an operating-system network sandbox and does not intercept UDP, native addon sockets, Bun-specific socket APIs or arbitrary networking inside child programs. The fixtures start only the fixed local commands shown in the harness; the result reports attempts through the guarded entry points, not a packet-level network audit.
