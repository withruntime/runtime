import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  checkUpstreams,
  compareRelease,
  compareSupportedLine,
  validateLock,
  type Upstream,
} from "../scripts/check-upstream";

const npm: Upstream = {
  registry: "npm",
  name: "@example/sdk",
  version: "1.2.3",
  artifacts: { "1.2.3": "sha512-original" },
};
const release = { version: "1.2.3", dist: { integrity: "sha512-original" } };
const lock = {
  schemaVersion: 1,
  checkedAt: "2026-09-29",
  providers: [{ id: "example", status: "partial", upstreams: [npm] }],
};

test("the manifest keeps all eleven approved providers and hashes every upstream", () => {
  const current = validateLock(
    JSON.parse(readFileSync(new URL("../compatibility-lock.json", import.meta.url), "utf8")),
  );
  expect(current.providers.map((p) => p.id).sort()).toEqual(
    [
      "e2b",
      "daytona",
      "vercel",
      "blaxel",
      "runloop",
      "codesandbox",
      "sprites",
      "freestyle",
      "prime",
      "modal",
      "cloudflare",
    ].sort(),
  );
});
test("unchanged packages pass while patch releases and replaced artifacts require review", () => {
  expect(compareRelease(npm, release).status).toBe("current");
  expect(compareRelease(npm, { ...release, version: "1.2.4" }).status).toBe("review");
  expect(compareRelease(npm, { ...release, dist: { integrity: "sha512-replaced" } }).status).toBe(
    "review",
  );
});
test("Python wheels added, removed or changed require review even at the same version", () => {
  const pin: Upstream = {
    registry: "pypi",
    name: "example",
    version: "1.0",
    artifacts: { "example.whl": "sha256-original" },
  };
  const data = {
    info: { version: "1.0" },
    urls: [{ filename: "example.whl", digests: { sha256: "original" } }],
  };
  expect(compareRelease(pin, data).status).toBe("current");
  expect(
    compareRelease(pin, {
      ...data,
      urls: [...data.urls, { filename: "new.whl", digests: { sha256: "new" } }],
    }).status,
  ).toBe("review");
  expect(
    compareRelease(pin, {
      ...data,
      urls: [{ filename: "example.whl", digests: { sha256: "changed" } }],
    }).status,
  ).toBe("review");
  expect(() => compareRelease(pin, { ...data, urls: [] })).toThrow();
});
test("upstream deprecation or yanking cannot look like an unchanged healthy release", () => {
  expect(
    compareRelease(npm, { ...release, deprecated: "Use the maintained replacement" }).status,
  ).toBe("review");
  const pin: Upstream = {
    registry: "pypi",
    name: "example",
    version: "1.0",
    artifacts: { "example.whl": "sha256-original" },
  };
  const data = {
    info: { version: "1.0" },
    urls: [{ filename: "example.whl", digests: { sha256: "original" } }],
  };
  expect(compareRelease(pin, { ...data, info: { ...data.info, yanked: true } }).status).toBe(
    "review",
  );
  expect(compareRelease(pin, { ...data, urls: [{ ...data.urls[0], yanked: true }] }).status).toBe(
    "review",
  );
});
test("network errors, registry refusals and malformed JSON are failures, never a stale pass", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("offline");
    },
    async () => new Response("busy", { status: 503 }),
    async () => new Response("not JSON"),
    async () => Response.json({}),
  ]) {
    const results = await checkUpstreams(validateLock(lock), fetcher);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("unavailable");
  }
});
test("registry paths encode scoped packages and do not send credentials", async () => {
  const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe("https://registry.npmjs.org/%40example%2Fsdk/latest");
    expect(options?.headers).toBeUndefined();
    expect(options?.redirect).toBe("error");
    return Response.json(release);
  };
  expect((await checkUpstreams(validateLock(lock), fetcher))[0]!.status).toBe("current");
});
test("empty, duplicated and unpinned manifests cannot disable the gate", () => {
  expect(() => validateLock({ ...lock, providers: [] })).toThrow();
  expect(() =>
    validateLock({ ...lock, providers: [...lock.providers, ...lock.providers] }),
  ).toThrow();
  expect(() =>
    validateLock({
      ...lock,
      providers: [{ ...lock.providers[0], upstreams: [{ ...npm, artifacts: {} }] }],
    }),
  ).toThrow();
});

const held: Upstream = {
  registry: "npm",
  name: "@example/sandbox",
  version: "0.12.10",
  artifacts: { "0.12.10": "sha512-pinned" },
  unsupported: {
    version: "1.0.0",
    artifacts: { "1.0.0": "sha512-reviewed" },
    reason: "1.0 is a different API",
  },
};
const registry = (
  versions: Record<string, { integrity: string; deprecated?: string }>,
  latest = "1.0.0",
) => ({
  "dist-tags": { latest },
  versions: Object.fromEntries(
    Object.entries(versions).map(([v, { integrity, deprecated }]) => [
      v,
      { dist: { integrity }, ...(deprecated ? { deprecated } : {}) },
    ]),
  ),
});
const line = {
  "0.12.9": { integrity: "sha512-old" },
  "0.12.10": { integrity: "sha512-pinned" },
  "1.0.0-rc.2": { integrity: "sha512-rc" },
  "1.0.0": { integrity: "sha512-reviewed" },
};
test("a reviewed unsupported major passes only while it is exactly that release", () => {
  expect(compareSupportedLine(held, registry(line)).status).toBe("current");
  expect(compareSupportedLine(held, registry(line)).message).toContain("not supported");
  // A newer release than the one reviewed is review work again.
  expect(
    compareSupportedLine(held, registry({ ...line, "1.0.1": { integrity: "sha512-x" } }, "1.0.1"))
      .status,
  ).toBe("review");
  // The reviewed release republished with other bytes is review work.
  expect(
    compareSupportedLine(held, registry({ ...line, "1.0.0": { integrity: "sha512-other" } }))
      .status,
  ).toBe("review");
  // Latest moving back to the pin means the record is stale.
  expect(compareSupportedLine(held, registry(line, "0.12.10")).status).toBe("review");
});
test("the supported line stays watched beneath a declined major", () => {
  expect(
    compareSupportedLine(held, registry({ ...line, "0.12.11": { integrity: "sha512-fix" } }))
      .message,
  ).toContain("0.12.11 was published on the supported line");
  expect(
    compareSupportedLine(
      held,
      registry({ ...line, "0.12.10": { integrity: "sha512-pinned", deprecated: "Use 1.0" } }),
    ).status,
  ).toBe("review");
  expect(
    compareSupportedLine(held, registry({ ...line, "0.12.10": { integrity: "sha512-swapped" } }))
      .status,
  ).toBe("review");
  const { "0.12.10": _, ...unpublished } = line;
  expect(compareSupportedLine(held, registry(unpublished)).status).toBe("review");
  // Prereleases between the two do not count as fixes on the supported line.
  expect(
    compareSupportedLine(held, registry({ ...line, "0.13.0-next.1": { integrity: "sha512-n" } }))
      .status,
  ).toBe("current");
});
test("an unsupported record must be a hashed, later, npm release with a reason", () => {
  const withPin = (pin: unknown) =>
    validateLock({ ...lock, providers: [{ ...lock.providers[0], upstreams: [pin] }] });
  expect(() => withPin(held)).not.toThrow();
  for (const bad of [
    { ...held.unsupported, reason: " " },
    { ...held.unsupported, version: "0.12.9", artifacts: { "0.12.9": "sha512-x" } },
    { ...held.unsupported, artifacts: {} },
    { ...held.unsupported, artifacts: { "1.0.1": "sha512-x" } },
  ])
    expect(() => withPin({ ...held, unsupported: bad })).toThrow();
  expect(() =>
    withPin({ ...held, registry: "pypi", artifacts: { "x.whl": "sha256-x" } }),
  ).toThrow();
});
test("a pin with a reviewed major reads the abbreviated version list, still without credentials", async () => {
  const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe("https://registry.npmjs.org/%40example%2Fsandbox");
    expect(options?.headers).toEqual({ accept: "application/vnd.npm.install-v1+json" });
    expect(options?.redirect).toBe("error");
    return Response.json(registry(line));
  };
  const results = await checkUpstreams(
    validateLock({ ...lock, providers: [{ ...lock.providers[0], upstreams: [held] }] }),
    fetcher,
  );
  expect(results[0]!.status).toBe("current");
  const broken = await checkUpstreams(
    validateLock({ ...lock, providers: [{ ...lock.providers[0], upstreams: [held] }] }),
    async () => Response.json({ versions: {} }),
  );
  expect(broken[0]!.status).toBe("unavailable");
});
test("the Cloudflare pin stays on the 0.x API it implements, with 1.0.0 recorded as reviewed", () => {
  const current = validateLock(
    JSON.parse(readFileSync(new URL("../compatibility-lock.json", import.meta.url), "utf8")),
  );
  const pin = current.providers.find((p) => p.id === "cloudflare")!.upstreams[0]!;
  expect(pin.version.startsWith("0.")).toBe(true);
  expect(pin.unsupported?.version).toBe("1.0.0");
});
