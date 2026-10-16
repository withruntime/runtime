import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  SANDBOX_BASE_URL,
  apiOrigin,
  defaultBaseUrl,
  PLACEHOLDER,
  inRuntimeSandbox,
  reachable,
  sandboxMarker,
} from "../src/transport";
import { Runtime } from "../src/index";

/* Inside a Runtime sandbox the API is reached at http://runtime.internal,
 * which the sandbox's host forwards to the public API (ARCHITECTURE.md
 * section 10, "Runtime's API from inside a sandbox"). */

test("with no base URL the SDK calls runtime.internal inside a sandbox and the public API elsewhere", () => {
  expect(defaultBaseUrl({}, () => true)).toBe(SANDBOX_BASE_URL);
  expect(defaultBaseUrl({}, () => false)).toBe(DEFAULT_BASE_URL);
  // Any other RUNTIME_API_URL wins wherever the code runs; an empty one is unset.
  expect(defaultBaseUrl({ RUNTIME_API_URL: "https://api.example.com" }, () => true)).toBe(
    "https://api.example.com",
  );
  expect(defaultBaseUrl({ RUNTIME_API_URL: "" }, () => true)).toBe(SANDBOX_BASE_URL);
});

test("in a sandbox, calls for the public API go to runtime.internal, since the public API is the sandbox's own host", () => {
  for (const origin of [DEFAULT_BASE_URL, `${DEFAULT_BASE_URL}/`]) {
    expect(reachable(origin, () => true)).toBe(SANDBOX_BASE_URL);
    expect(reachable(origin, () => false)).toBe(origin);
    expect(defaultBaseUrl({ RUNTIME_API_URL: origin }, () => true)).toBe(SANDBOX_BASE_URL);
  }
  expect(reachable("https://api.example.com", () => true)).toBe("https://api.example.com");
  expect(reachable("http://localhost:8787", () => true)).toBe("http://localhost:8787");
  // Outside a sandbox (this machine), a client keeps the origin it was given.
  expect(new Runtime({ apiKey: "rt_key", baseUrl: DEFAULT_BASE_URL }).transport.baseUrl).toBe(
    inRuntimeSandbox() ? SANDBOX_BASE_URL : DEFAULT_BASE_URL,
  );
});

test("in a sandbox, a secret's placeholder key calls the public API, where the sandbox's proxy puts the key in; a real key still calls runtime.internal", async () => {
  // runtime.internal reaches the host without passing the proxy, so the
  // placeholder arrived as the key and every call answered 401 (11 October 2026).
  const directory = await mkdtemp(join(tmpdir(), "rt-sandbox-origin-"));
  const before = sandboxMarker.path;
  try {
    sandboxMarker.path = join(directory, "environment.json");
    await writeFile(sandboxMarker.path, "{}");
    expect(new Runtime({ apiKey: `${PLACEHOLDER}5ab2668c` }).transport.baseUrl).toBe(
      DEFAULT_BASE_URL,
    );
    expect(
      new Runtime({ apiKey: `${PLACEHOLDER}5ab2668c`, baseUrl: DEFAULT_BASE_URL }).transport
        .baseUrl,
    ).toBe(DEFAULT_BASE_URL);
    expect(new Runtime({ apiKey: "rt_key" }).transport.baseUrl).toBe(SANDBOX_BASE_URL);
    expect(
      new Runtime({ apiKey: `${PLACEHOLDER}5ab2668c`, baseUrl: "https://api.example.com" })
        .transport.baseUrl,
    ).toBe("https://api.example.com");
  } finally {
    sandboxMarker.path = before;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a sandbox is recognised by the environment file every Runtime guest keeps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rt-sandbox-origin-"));
  try {
    const marker = join(directory, "environment.json");
    expect(inRuntimeSandbox(marker)).toBe(false);
    await writeFile(marker, "{}");
    expect(inRuntimeSandbox(marker)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("http://runtime.internal is an accepted origin; other plain-HTTP names and forms of it are not", () => {
  expect(apiOrigin("http://runtime.internal")).toBe("http://runtime.internal");
  expect(apiOrigin("http://runtime.internal/")).toBe("http://runtime.internal");
  for (const origin of [
    "https://runtime.internal",
    "http://runtime.internal:8080",
    "http://runtime.internal/v1",
    "http://user@runtime.internal",
    "http://api.withruntime.com",
    "http://runtime.internal.example.com",
  ])
    expect(() => apiOrigin(origin)).toThrow(/HTTPS API origin/);
});
