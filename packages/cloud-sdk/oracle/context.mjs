/* global process, console, Bun, Response, Request, URL */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
export const runtimeRoot = resolve(
  process.env.RUNTIME_ORACLE_RUNTIME_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url)),
);
const officialRoot = process.env.RUNTIME_ORACLE_OFFICIAL_ROOT;
assert(
  officialRoot,
  "Set RUNTIME_ORACLE_OFFICIAL_ROOT to the directory containing the installed pinned package.json and bun.lock",
);
const official = resolve(officialRoot),
  checked = JSON.parse(
    await fs.readFile(join(runtimeRoot, "packages/cloud-sdk/compatibility-lock.json"), "utf8"),
  ),
  dependencyLock = await fs.readFile(join(official, "bun.lock"), "utf8");
for (const name of [
  "e2b",
  "@e2b/code-interpreter",
  "@daytona/sdk",
  "@vercel/sandbox",
  "@blaxel/core",
]) {
  const pinned = checked.providers
    .flatMap((p) => p.upstreams)
    .find((d) => d.registry === "npm" && d.name === name);
  assert(pinned, `Missing contract pin ${name}`);
  const installed = JSON.parse(
    await fs.readFile(join(official, "node_modules", name, "package.json"), "utf8"),
  );
  assert.equal(installed.version, pinned.version, `Version mismatch ${name}`);
  const line = dependencyLock
    .split(
      `
`,
    )
    .find((s) => s.startsWith(`    ${JSON.stringify(name)}: [`));
  assert(line, `Missing dependency integrity ${name}`);
  const record = JSON.parse(line.slice(line.indexOf(": ") + 2).replace(/,$/, ""));
  assert.equal(
    record.at(-1),
    pinned.artifacts[pinned.version],
    `Tarball integrity mismatch ${name}`,
  );
}
export async function loadOfficial(name, file) {
  return import(pathToFileURL(join(official, "node_modules", name, file)).href);
}
export async function loadRuntime(file) {
  return import(pathToFileURL(join(runtimeRoot, "packages/cloud-sdk/src", file)).href);
}
export const checks = [];
export async function check(name, work) {
  try {
    await work();
    checks.push({ name, ok: !0 });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: !1, error: String(error) });
    console.error(`FAIL ${name}: ${error}`);
  }
}

export { assert, fs, join };
export async function outcome(work) {
  try {
    const value = await work();
    return { ok: !0, value: value === void 0 ? "undefined" : value };
  } catch (error) {
    return { ok: !1, name: error.name, code: error.code, syscall: error.syscall };
  }
}
export async function shell(cmd, options = {}) {
  options.signal?.throwIfAborted();
  const argv = typeof cmd === "string" ? ["bash", "-c", cmd] : cmd,
    child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut: !1, stdoutTruncated: !1, stderrTruncated: !1 };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
const savedFetch = globalThis.fetch,
  socketConnect = net.Socket.prototype.connect,
  tlsConnect = tls.connect,
  savedWebSocket = globalThis.WebSocket;
let fixture;
export const intercepted = [],
  prohibited = [];
function denied(kind) {
  prohibited.push(kind);
  throw Error(`Oracle prohibited ${kind}`);
}
net.Socket.prototype.connect = function () {
  return denied("socket.connect");
};
tls.connect = function () {
  return denied("tls.connect");
};
globalThis.WebSocket = class {
  constructor() {
    denied("WebSocket");
  }
};
globalThis.fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  if (new URL(req.url).origin !== "http://offline-fixture.invalid" || !fixture)
    return denied("fetch outside fixture");
  intercepted.push(req.method + " " + new URL(req.url).pathname);
  return fixture(req);
};
syncBuiltinESMExports();
export function setFixture(handler) {
  fixture = handler;
}
export function restoreNetwork() {
  globalThis.fetch = savedFetch;
  net.Socket.prototype.connect = socketConnect;
  tls.connect = tlsConnect;
  globalThis.WebSocket = savedWebSocket;
  syncBuiltinESMExports();
}
