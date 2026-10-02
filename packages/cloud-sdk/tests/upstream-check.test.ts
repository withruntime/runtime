import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  checkUpstreams,
  compareRelease,
  compareSupportedLine,
  compareLatestReview,
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

const reviewNpm: Upstream = {
  ...npm,
  latestReview: {
    version: "1.2.4",
    artifacts: { "1.2.4": "sha512-reviewed" },
    reviewedAt: "2026-10-01",
    disposition: "held-for-sdk-qualification",
    evidence: {
      sourceUrls: ["https://registry.npmjs.org/%40example%2Fsdk/1.2.4"],
      artifactSha256: { "1.2.4": "a".repeat(64) },
      changes: ["Fixture: source changed; installed qualification not run."],
    },
  },
};
const reviewNpmDocument = () => ({
  "dist-tags": { latest: "1.2.4" },
  versions: {
    "1.2.3": structuredClone(release),
    "1.2.4": { version: "1.2.4", dist: { integrity: "sha512-reviewed" } },
  },
});
const reviewPy: Upstream = {
  registry: "pypi",
  name: "example",
  version: "1.2.3",
  artifacts: { "old.whl": `sha256-${"b".repeat(64)}` },
  latestReview: {
    ...reviewNpm.latestReview!,
    artifacts: { "new.whl": `sha256-${"a".repeat(64)}` },
    evidence: {
      sourceUrls: ["https://pypi.org/pypi/example/1.2.4/json"],
      artifactSha256: { "new.whl": "a".repeat(64) },
      changes: ["Fixture source review, no compatibility qualification."],
    },
  },
};
const pyRelease = (version: string, filename: string, digest: string) => ({
  info: { version, yanked: false },
  urls: [{ filename, digests: { sha256: digest }, yanked: false }],
});
const reviewPyDocument = () => ({
  ...pyRelease("1.2.4", "new.whl", "a".repeat(64)),
  releases: {
    "1.2.3": pyRelease("1.2.3", "old.whl", "b".repeat(64)).urls,
    "1.2.4": pyRelease("1.2.4", "new.whl", "a".repeat(64)).urls,
  },
});
const pinnedPyDocument = () => pyRelease("1.2.3", "old.whl", "b".repeat(64));
const oneReviewLock = (pin: Upstream) => ({
  ...lock,
  providers: [{ id: "example", status: "partial", upstreams: [pin] }],
});

test("a reviewed latest release holds qualification without advancing either registry pin", () => {
  for (const [pin, document, pinned] of [
    [reviewNpm, reviewNpmDocument(), undefined],
    [reviewPy, reviewPyDocument(), pinnedPyDocument()],
  ] as const) {
    expect(validateLock(oneReviewLock(pin)).providers[0]!.upstreams[0]!.version).toBe("1.2.3");
    expect(
      compareRelease(
        pin,
        pin.registry === "npm"
          ? (document as ReturnType<typeof reviewNpmDocument>).versions["1.2.4"]
          : document,
      ).status,
    ).toBe("review");
    const result = compareLatestReview(pin, document, pinned);
    expect(result.status).toBe("current");
    expect(result.message).toContain("qualification deferred");
    expect(result.message).toContain("latest compatibility unqualified");
  }
});

test("reviewed npm monitoring refuses changed latest, either hash, removal, deprecation and intervening releases", () => {
  const mutations = [
    (d: ReturnType<typeof reviewNpmDocument>) => {
      d["dist-tags"].latest = "1.2.5";
    },
    (d: ReturnType<typeof reviewNpmDocument>) => {
      d.versions["1.2.3"].dist.integrity = "sha512-drift";
    },
    (d: ReturnType<typeof reviewNpmDocument>) => {
      d.versions["1.2.4"].dist.integrity = "sha512-drift";
    },
    (d: ReturnType<typeof reviewNpmDocument>) => {
      delete (d.versions as Record<string, unknown>)["1.2.3"];
    },
    (d: ReturnType<typeof reviewNpmDocument>) => {
      delete (d.versions as Record<string, unknown>)["1.2.4"];
    },
    (d: ReturnType<typeof reviewNpmDocument>) => {
      Object.assign(d.versions["1.2.3"], { deprecated: "old withdrawn" });
    },
    (d: ReturnType<typeof reviewNpmDocument>) => {
      Object.assign(d.versions["1.2.4"], { deprecated: "latest withdrawn" });
    },
  ];
  for (const mutate of mutations) {
    const document = reviewNpmDocument();
    mutate(document);
    expect(compareLatestReview(reviewNpm, document).status).toBe("review");
  }
  const intermediate = {
    ...reviewNpm,
    version: "1.2.2",
    artifacts: { "1.2.2": "sha512-original" },
  };
  const document = reviewNpmDocument();
  Object.assign(document.versions, { "1.2.2": { ...structuredClone(release), version: "1.2.2" } });
  expect(compareLatestReview(intermediate, document).status).toBe("review");
});

test("reviewed Python monitoring refuses changed inventories, yanking, pin replacement and hidden stable releases", () => {
  for (const subject of ["pinned", "latest"] as const) {
    for (const defect of ["hash", "added", "removed", "yanked", "file-yanked"] as const) {
      const latest = reviewPyDocument(),
        pinned = pinnedPyDocument();
      const changed = subject === "pinned" ? pinned : latest;
      if (defect === "hash") changed.urls[0]!.digests.sha256 = "c".repeat(64);
      if (defect === "added") changed.urls.push({ ...changed.urls[0]!, filename: "added.whl" });
      if (defect === "removed") changed.urls.pop();
      if (defect === "yanked") changed.info.yanked = true;
      if (defect === "file-yanked") changed.urls[0]!.yanked = true;
      if (defect === "removed")
        expect(() => compareLatestReview(reviewPy, latest, pinned)).toThrow();
      else expect(compareLatestReview(reviewPy, latest, pinned).status).toBe("review");
    }
  }
  const latest = reviewPyDocument();
  latest.info.version = "1.2.5";
  expect(compareLatestReview(reviewPy, latest, pinnedPyDocument()).status).toBe("review");
  const hidden = reviewPyDocument();
  Object.assign(hidden.releases, { "1.2.5": [{}] });
  expect(compareLatestReview(reviewPy, hidden, pinnedPyDocument()).status).toBe("review");
  expect(
    compareLatestReview(reviewPy, reviewPyDocument(), {
      ...pinnedPyDocument(),
      info: { version: "wrong", yanked: false },
    }).status,
  ).toBe("review");
});

test("review records refuse mixed mechanisms, missing evidence and malformed artifact binding", () => {
  const mutations: Array<(pin: Upstream) => void> = [
    (p) => {
      p.unsupported = {
        version: "2.0.0",
        artifacts: { "2.0.0": "sha512-other" },
        reason: "different API",
      };
    },
    (p) => {
      p.latestReview!.version = p.version;
    },
    (p) => {
      p.latestReview!.reviewedAt = "invalid";
    },
    (p) => {
      p.latestReview!.disposition = "supported" as never;
    },
    (p) => {
      p.latestReview!.evidence.changes = [];
    },
    (p) => {
      p.latestReview!.evidence.sourceUrls = ["http://untrusted.invalid"];
    },
    (p) => {
      p.latestReview!.evidence.artifactSha256 = {};
    },
    (p) => {
      p.latestReview!.evidence.artifactSha256 = { unexpected: "a".repeat(64) };
    },
    (p) => {
      p.latestReview!.artifacts = {};
    },
  ];
  for (const mutate of mutations) {
    const pin = structuredClone(reviewNpm);
    mutate(pin);
    expect(() => validateLock(oneReviewLock(pin))).toThrow();
  }
  const py = structuredClone(reviewPy);
  py.latestReview!.evidence.artifactSha256["new.whl"] = "b".repeat(64);
  expect(() => validateLock(oneReviewLock(py))).toThrow();
});

test("reviewed registry failures and malformed payloads never become current", async () => {
  for (const pin of [reviewNpm, reviewPy]) {
    for (const fetcher of [
      async () => {
        throw new Error("offline");
      },
      async () => new Response("{}", { status: 503 }),
    ]) {
      expect((await checkUpstreams(validateLock(oneReviewLock(pin)), fetcher))[0]!.status).toBe(
        "unavailable",
      );
    }
  }
  const duplicate = reviewPyDocument();
  duplicate.urls.push({ ...duplicate.urls[0]! });
  expect(() => compareLatestReview(reviewPy, duplicate, pinnedPyDocument())).toThrow();
  const absentHealth = reviewPyDocument();
  delete (absentHealth.info as Partial<typeof absentHealth.info>).yanked;
  expect(() => compareLatestReview(reviewPy, absentHealth, pinnedPyDocument())).toThrow();
  const absentInventory = reviewPyDocument();
  absentInventory.releases["1.2.3"] = [];
  expect(() => compareLatestReview(reviewPy, absentInventory, pinnedPyDocument())).toThrow();
});

test("reviewed Python fetches the exact older subject separately, without weakening registry fences", async () => {
  const urls: string[] = [];
  const findings = await checkUpstreams(
    validateLock(oneReviewLock(reviewPy)),
    async (url, options) => {
      urls.push(url);
      expect(options!.redirect).toBe("error");
      expect(options!.signal).toBeDefined();
      return Response.json(url.endsWith("/1.2.3/json") ? pinnedPyDocument() : reviewPyDocument());
    },
  );
  expect(urls).toEqual([
    "https://pypi.org/pypi/example/json",
    "https://pypi.org/pypi/example/1.2.3/json",
  ]);
  expect(findings[0]!.status).toBe("current");
  expect(
    (
      await checkUpstreams(validateLock(oneReviewLock(reviewPy)), async (url) =>
        url.endsWith("/1.2.3/json")
          ? new Response("missing", { status: 404 })
          : Response.json(reviewPyDocument()),
      )
    )[0]!.status,
  ).toBe("unavailable");
});

test("Python release-list inconsistencies cannot hide behind unchanged exact endpoint urls", () => {
  for (const version of ["1.2.3", "1.2.4"] as const) {
    for (const defect of ["hash", "added", "removed", "yanked", "duplicate"] as const) {
      const latest = reviewPyDocument(),
        files = latest.releases[version];
      if (defect === "hash") files[0]!.digests.sha256 = "c".repeat(64);
      if (defect === "added") files.push({ ...files[0]!, filename: "added.whl" });
      if (defect === "removed") files.pop();
      if (defect === "yanked") files[0]!.yanked = true;
      if (defect === "duplicate") files.push({ ...files[0]! });
      if (defect === "removed" || defect === "duplicate")
        expect(() => compareLatestReview(reviewPy, latest, pinnedPyDocument())).toThrow();
      else expect(compareLatestReview(reviewPy, latest, pinnedPyDocument()).status).toBe("review");
    }
  }
});

test("malformed reviewed HTTP200 metadata is fatal review, never an outer offline warning", async () => {
  for (const pin of [reviewNpm, reviewPy]) {
    for (const body of ["{}", "not-json", "null", "[]"]) {
      const finding = (
        await checkUpstreams(validateLock(oneReviewLock(pin)), async () => new Response(body))
      )[0]!;
      expect(finding.status).toBe("review");
      // scripts/check.ts network() refuses [review], while [unavailable] may warn offline.
      expect(`[${finding.status}] example / ${pin.name}: ${finding.message}`).toContain("[review]");
    }
  }
  const badList = reviewPyDocument();
  badList.releases["1.2.3"] = [];
  expect(
    (
      await checkUpstreams(validateLock(oneReviewLock(reviewPy)), async (url) =>
        Response.json(url.endsWith("/1.2.3/json") ? pinnedPyDocument() : badList),
      )
    )[0]!.status,
  ).toBe("review");
  expect(
    (
      await checkUpstreams(validateLock(oneReviewLock(reviewPy)), async (url) =>
        url.endsWith("/1.2.3/json") ? new Response("bad-json") : Response.json(reviewPyDocument()),
      )
    )[0]!.status,
  ).toBe("review");
});

test("Python monitoring includes numeric two-part and post releases; unknown stable spelling refuses", () => {
  for (const version of ["1.3", "1.2.3.post1", "1.2.4.post1"]) {
    const document = reviewPyDocument();
    Object.assign(document.releases, { [version]: [{}] });
    expect(compareLatestReview(reviewPy, document, pinnedPyDocument()).status).toBe("review");
  }
  const prerelease = reviewPyDocument();
  Object.assign(prerelease.releases, { "1.3rc1.post0": [{}] });
  expect(compareLatestReview(reviewPy, prerelease, pinnedPyDocument()).status).toBe("current");
  const unknown = reviewPyDocument();
  Object.assign(unknown.releases, { "2!1.0": [{}] });
  expect(() => compareLatestReview(reviewPy, unknown, pinnedPyDocument())).toThrow();
});

test("malformed latest metadata is fatal before an older subject transport can fail", async () => {
  let calls = 0;
  const latest = reviewPyDocument();
  latest.releases["1.2.3"] = [];
  const finding = (
    await checkUpstreams(validateLock(oneReviewLock(reviewPy)), async () => {
      calls++;
      if (calls > 1) throw new Error("offline pinned endpoint");
      return Response.json(latest);
    })
  )[0]!;
  expect(finding.status).toBe("review");
  expect(calls).toBe(1);
});

test("malformed reviewed lock records are fatal before network access", async () => {
  const pin = structuredClone(reviewNpm);
  pin.latestReview!.evidence.changes = [];
  let calls = 0;
  const finding = (
    await checkUpstreams(oneReviewLock(pin) as Parameters<typeof checkUpstreams>[0], async () => {
      calls++;
      throw new Error("offline");
    })
  )[0]!;
  expect(finding.status).toBe("review");
  expect(calls).toBe(0);
});

test("npm latest is authoritative when an older mistaken major release remains published", () => {
  // Official @blaxel/core metadata, 1 October 2026: latest 0.3.25;
  // 3.0.5 was published 20 July 2026, deprecated as a mistaken 0.3.5 publication.
  const document = reviewNpmDocument();
  Object.assign(document.versions, {
    "3.0.5": {
      version: "3.0.5",
      deprecated: "Published by mistake, use 0.3.5 or later instead",
      dist: { integrity: "sha512-historical" },
    },
  });
  Object.assign(document, {
    time: {
      "3.0.5": "2026-07-20T08:09:47.352Z",
      "1.2.3": "2026-09-28T00:00:00.000Z",
      "1.2.4": "2026-09-30T00:00:00.000Z",
    },
  });
  expect(compareLatestReview(reviewNpm, document).status).toBe("current");
  document["dist-tags"].latest = "3.0.5";
  expect(compareLatestReview(reviewNpm, document).status).toBe("review");
});
