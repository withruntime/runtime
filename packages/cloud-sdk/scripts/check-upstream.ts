/** Check public SDK versions and package integrity without installing or
 * executing upstream code. A newer version is review work, never an automatic
 * expansion of the compatibility claim. A release reviewed and found to be a
 * different API is recorded on its pin as `unsupported`; it passes only while it
 * is exactly that release, and the pinned line is still watched beneath it. */
import { readFileSync } from "node:fs";

export type Upstream = {
  registry: "npm" | "pypi";
  name: string;
  version: string;
  artifacts: Record<string, string>;
  /** A newer release reviewed and declined because it is not the API Runtime
   * implements. npm only; the pin stays the supported version. */
  unsupported?: { version: string; artifacts: Record<string, string>; reason: string };
  /** Authentic artifacts/source reviewed, but installed consumer qualification
   * is deferred. This is monitoring evidence, never support for this version. */
  latestReview?: {
    version: string;
    artifacts: Record<string, string>;
    reviewedAt: string;
    disposition: "held-for-sdk-qualification";
    evidence: { sourceUrls: string[]; artifactSha256: Record<string, string>; changes: string[] };
  };
};
export type CompatibilityLock = {
  schemaVersion: number;
  checkedAt: string;
  providers: Array<{ id: string; status: "partial" | "verified"; upstreams: Upstream[] }>;
};
export type Finding = {
  provider: string;
  package: string;
  status: "current" | "review" | "unavailable";
  message: string;
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid registry response");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new Error("Missing registry field");
  return value;
};

export function compareRelease(pin: Upstream, raw: unknown): Omit<Finding, "provider" | "package"> {
  const data = object(raw);
  if (pin.registry === "npm" && typeof data.deprecated === "string" && data.deprecated.trim())
    return {
      status: "review",
      message:
        "The pinned package is deprecated upstream. Review its replacement before releasing.",
    };
  if (
    pin.registry === "pypi" &&
    (object(data.info).yanked === true ||
      (Array.isArray(data.urls) && data.urls.some((item) => object(item).yanked === true)))
  )
    return {
      status: "review",
      message:
        "The pinned Python release or distribution was yanked upstream. Review before releasing.",
    };
  const version = pin.registry === "npm" ? string(data.version) : string(object(data.info).version);
  if (version !== pin.version)
    return {
      status: "review",
      message: `Pinned ${pin.version}; latest is ${version}. Run compatibility tests before updating the pin.`,
    };
  let artifacts: Record<string, string>;
  if (pin.registry === "npm") {
    artifacts = { [version]: string(object(data.dist).integrity) };
  } else {
    if (!Array.isArray(data.urls) || !data.urls.length)
      throw new Error("No published distributions");
    artifacts = Object.fromEntries(
      data.urls.map((item) => {
        const file = object(item);
        return [string(file.filename), `sha256-${string(object(file.digests).sha256)}`];
      }),
    );
  }
  const unchanged =
    Object.keys(artifacts).length === Object.keys(pin.artifacts).length &&
    Object.entries(pin.artifacts).every(([file, hash]) => artifacts[file] === hash);
  return unchanged
    ? {
        status: "current",
        message: `${version}: pinned package unchanged (not a claim of full compatibility).`,
      }
    : {
        status: "review",
        message: `${version}: published artifacts changed. Inspect before updating the pin.`,
      };
}

const stable = (version: string) => /^\d+\.\d+\.\d+$/.test(version);
// PyPI stable releases may have fewer numeric components or a post release.
// Unknown non-prerelease spellings refuse rather than silently hiding a release.
const pythonStable = (version: string): boolean => {
  const match = /^(\d+(?:\.\d+)*)(?:(?:\.?post|\.?r|-)(\d+))?$/i.exec(version);
  if (match) return true;
  if (
    /^\d+(?:\.\d+)*(?:a|b|rc|\.?(?:alpha|beta|pre|preview|dev))\d*(?:\.post\d+)?(?:\.dev\d+)?$/i.test(
      version,
    )
  )
    return false;
  throw new Error(`Unrecognized Python release version ${version}`);
};
const pythonOrder = (left: string, right: string): number => {
  const split = (version: string) => {
    const match = /^(\d+(?:\.\d+)*)(?:(?:\.?post|\.?r|-)(\d+))?$/i.exec(version)!;
    return {
      parts: match[1]!.split(".").map(Number),
      post: match[2] === undefined ? -1 : Number(match[2]),
    };
  };
  const a = split(left),
    b = split(right);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const difference = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (difference) return difference;
  }
  return a.post - b.post;
};

/** ARCHITECTURE.md: Competitor SDK compatibility. An exact source review can
 * hold qualification without advancing the supported pin or its claim. Both
 * subjects remain hash/health watched; npm latest and intervening supported-line
 * releases remain watched. Python stable release inventories remain watched. */
export function compareLatestReview(
  pin: Upstream,
  raw: unknown,
  pinnedRaw?: unknown,
): Omit<Finding, "provider" | "package"> {
  const reviewed = pin.latestReview;
  if (!reviewed || pin.unsupported) throw new Error("Missing or conflicting latest review");
  const data = object(raw);
  let latestRaw: unknown;
  let versions: Record<string, unknown>;
  let latest: string;
  if (pin.registry === "npm") {
    latest = string(object(data["dist-tags"]).latest);
    versions = object(data.versions);
    pinnedRaw = versions[pin.version];
    latestRaw = versions[latest];
  } else {
    latest = string(object(data.info).version);
    versions = object(data.releases);
    latestRaw = data;
  }
  if (latest !== reviewed.version)
    return {
      status: "review",
      message: `Pinned ${pin.version}; reviewed ${reviewed.version}, but latest is now ${latest}. Review before releasing.`,
    };
  if (pinnedRaw === undefined || latestRaw === undefined)
    return { status: "review", message: "Pinned or reviewed release is no longer published." };
  const healthy = (subject: Upstream, raw: unknown) => {
    const entry = object(raw);
    if (subject.registry === "npm") {
      if (entry.deprecated !== undefined && typeof entry.deprecated !== "string")
        throw new Error("Malformed deprecation field");
    } else {
      if (typeof object(entry.info).yanked !== "boolean" || !Array.isArray(entry.urls))
        throw new Error("Malformed Python release health");
      const names = new Set<string>();
      for (const raw of entry.urls) {
        const file = object(raw);
        const name = string(file.filename);
        if (names.has(name) || typeof file.yanked !== "boolean")
          throw new Error("Duplicate or malformed Python distribution");
        names.add(name);
      }
    }
    return compareRelease(subject, entry);
  };
  const pinned = healthy(pin, pinnedRaw);
  if (pinned.status !== "current") return pinned;
  const reviewedResult = healthy(
    { ...pin, version: reviewed.version, artifacts: reviewed.artifacts },
    latestRaw,
  );
  if (reviewedResult.status !== "current") return reviewedResult;
  if (versions[pin.version] === undefined || versions[reviewed.version] === undefined)
    return {
      status: "review",
      message: "Pinned or reviewed release is missing from the published version list.",
    };
  if (
    pin.registry === "pypi" &&
    [pin.version, reviewed.version].some(
      (version) => !Array.isArray(versions[version]) || !(versions[version] as unknown[]).length,
    )
  )
    throw new Error("Malformed or empty published Python release inventory");
  if (pin.registry === "pypi") {
    for (const subject of [
      pin,
      { ...pin, version: reviewed.version, artifacts: reviewed.artifacts },
    ]) {
      const listed = healthy(subject, {
        info: { version: subject.version, yanked: false },
        urls: versions[subject.version],
      });
      if (listed.status !== "current") return listed;
    }
  }
  const order = pin.registry === "pypi" ? pythonOrder : Bun.semver.order;
  const unreviewed = Object.keys(versions).filter(
    (version) =>
      (pin.registry === "pypi" ? pythonStable(version) : stable(version)) &&
      version !== reviewed.version &&
      order(version, pin.version) > 0 &&
      // npm's latest tag defines the reviewed release channel. Higher-numbered
      // historical/other-channel releases do not override that authoritative tag.
      // Keep watching stable fixes between the supported pin and reviewed latest.
      (pin.registry === "pypi" || order(version, reviewed.version) < 0),
  );
  if (unreviewed.length)
    return {
      status: "review",
      message: `Unreviewed stable release ${unreviewed.sort(order).at(-1)} requires review before releasing.`,
    };
  return {
    status: "current",
    message: `${pin.version}: supported pin unchanged; latest ${latest} source reviewed, qualification deferred (latest compatibility unqualified).`,
  };
}

/** For a pin with a reviewed `unsupported` release, read the registry's full
 * version list: pass only while `latest` is that exact reviewed release, the
 * pinned release is unchanged and not deprecated, and nothing stable was
 * published between the two (a fix on the supported line is review work). */
export function compareSupportedLine(
  pin: Upstream,
  raw: unknown,
): Omit<Finding, "provider" | "package"> {
  const declined = pin.unsupported;
  if (!declined) throw new Error("Pin has no reviewed unsupported release");
  const data = object(raw);
  const latest = string(object(data["dist-tags"]).latest);
  const versions = object(data.versions);
  const integrity = (version: string) => {
    const entry = versions[version];
    return entry === undefined ? undefined : string(object(object(entry).dist).integrity);
  };
  if (latest === pin.version)
    return {
      status: "review",
      message: `Latest is back to the pinned ${pin.version}; remove the unsupported ${declined.version} record.`,
    };
  if (latest !== declined.version)
    return {
      status: "review",
      message: `Pinned ${pin.version}; ${declined.version} was reviewed, but latest is now ${latest}. Review it before updating the lock.`,
    };
  if (integrity(latest) !== declined.artifacts[latest])
    return {
      status: "review",
      message: `${latest}: published artifacts changed since the review. Inspect before updating the lock.`,
    };
  const pinned = versions[pin.version];
  if (pinned === undefined)
    return { status: "review", message: `Pinned ${pin.version} is no longer published.` };
  const deprecated = object(pinned).deprecated;
  if (typeof deprecated === "string" && deprecated.trim())
    return {
      status: "review",
      message:
        "The pinned package is deprecated upstream. Review its replacement before releasing.",
    };
  if (integrity(pin.version) !== pin.artifacts[pin.version])
    return {
      status: "review",
      message: `${pin.version}: published artifacts changed. Inspect before updating the pin.`,
    };
  const between = Object.keys(versions).filter(
    (version) =>
      stable(version) &&
      Bun.semver.order(version, pin.version) > 0 &&
      Bun.semver.order(version, declined.version) < 0,
  );
  if (between.length)
    return {
      status: "review",
      message: `Pinned ${pin.version}; ${between.sort(Bun.semver.order).at(-1)} was published on the supported line. Run compatibility tests before updating the pin.`,
    };
  return {
    status: "current",
    message: `${pin.version}: pinned package unchanged; latest ${latest} reviewed and not supported (${declined.reason}).`,
  };
}

export function validateLock(value: unknown): CompatibilityLock {
  const lock = object(value);
  if (
    lock.schemaVersion !== 1 ||
    typeof lock.checkedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(lock.checkedAt) ||
    !Array.isArray(lock.providers) ||
    !lock.providers.length
  )
    throw new Error("Invalid compatibility lock");
  const ids = new Set<string>();
  const packages = new Set<string>();
  for (const raw of lock.providers) {
    const provider = object(raw);
    const id = string(provider.id);
    if (ids.has(id)) throw new Error(`Duplicate provider ${id}`);
    ids.add(id);
    if (
      !["partial", "verified"].includes(string(provider.status)) ||
      !Array.isArray(provider.upstreams) ||
      !provider.upstreams.length
    )
      throw new Error(`Invalid provider ${id}`);
    for (const raw of provider.upstreams) {
      const pin = object(raw);
      if (pin.registry !== "npm" && pin.registry !== "pypi") throw new Error("Unknown registry");
      const name = string(pin.name);
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))
        throw new Error("Invalid package name");
      const key = `${pin.registry}:${name}`;
      if (packages.has(key)) throw new Error(`Duplicate package ${key}`);
      packages.add(key);
      const version = string(pin.version);
      const hashed = (value: unknown) => {
        const artifacts = object(value);
        if (
          !Object.keys(artifacts).length ||
          Object.values(artifacts).some(
            (v) => typeof v !== "string" || !/^sha(?:256|512)-\S+$/.test(v),
          )
        )
          throw new Error(`Missing artifact hashes for ${name}`);
        return artifacts;
      };
      hashed(pin.artifacts);
      if (pin.latestReview !== undefined) {
        const reviewed = object(pin.latestReview);
        const reviewedVersion = string(reviewed.version);
        const artifacts = hashed(reviewed.artifacts);
        const evidence = object(reviewed.evidence);
        const byteHashes = object(evidence.artifactSha256);
        if (
          pin.unsupported !== undefined ||
          !stable(version) ||
          !stable(reviewedVersion) ||
          Bun.semver.order(reviewedVersion, version) <= 0 ||
          reviewed.disposition !== "held-for-sdk-qualification" ||
          typeof reviewed.reviewedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(reviewed.reviewedAt) ||
          (pin.registry === "npm" && Object.keys(artifacts).join() !== reviewedVersion) ||
          Object.keys(byteHashes).length !== Object.keys(artifacts).length ||
          Object.keys(artifacts).some(
            (file) =>
              typeof byteHashes[file] !== "string" || !/^[a-f0-9]{64}$/.test(byteHashes[file]),
          ) ||
          (pin.registry === "pypi" &&
            Object.keys(artifacts).some(
              (file) => artifacts[file] !== `sha256-${string(byteHashes[file])}`,
            )) ||
          !Array.isArray(evidence.sourceUrls) ||
          !evidence.sourceUrls.length ||
          evidence.sourceUrls.some(
            (url) =>
              typeof url !== "string" ||
              !/^https:\/\/(?:registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|github\.com)\//.test(
                url,
              ),
          ) ||
          !Array.isArray(evidence.changes) ||
          !evidence.changes.length ||
          evidence.changes.some((change) => typeof change !== "string" || !change.trim())
        )
          throw new Error(`Invalid latest review for ${name}`);
      }
      if (pin.unsupported !== undefined) {
        const declined = object(pin.unsupported);
        const declinedVersion = string(declined.version);
        if (
          pin.registry !== "npm" ||
          !stable(version) ||
          !stable(declinedVersion) ||
          Bun.semver.order(declinedVersion, version) <= 0 ||
          !string(declined.reason).trim() ||
          Object.keys(hashed(declined.artifacts)).join() !== declinedVersion
        )
          throw new Error(`Invalid unsupported release for ${name}`);
      }
    }
  }
  return lock as CompatibilityLock;
}

export async function checkUpstreams(
  lock: CompatibilityLock,
  fetcher: (url: string, options?: RequestInit) => Promise<Response> = fetch,
): Promise<Finding[]> {
  const tasks = lock.providers.flatMap((provider) =>
    provider.upstreams.map((pin) => ({ provider: provider.id, pin })),
  );
  const findings: Finding[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (next < tasks.length) {
        const task = tasks[next++]!;
        const pin = task.pin;
        let reviewingMetadata = false;
        try {
          if (pin.latestReview !== undefined) {
            reviewingMetadata = true;
            validateLock({
              schemaVersion: 1,
              checkedAt: lock.checkedAt,
              providers: [{ id: task.provider, status: "partial", upstreams: [pin] }],
            });
            reviewingMetadata = false;
          }
          const line =
            pin.unsupported !== undefined ||
            (pin.registry === "npm" && pin.latestReview !== undefined);
          const url =
            pin.registry === "pypi"
              ? `https://pypi.org/pypi/${encodeURIComponent(pin.name)}/json`
              : line
                ? `https://registry.npmjs.org/${encodeURIComponent(pin.name)}`
                : `https://registry.npmjs.org/${encodeURIComponent(pin.name)}/latest`;
          const response = await fetcher(url, {
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
            // The abbreviated document lists every version with its integrity and deprecation.
            ...(line ? { headers: { accept: "application/vnd.npm.install-v1+json" } } : {}),
          });
          if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
          const text = pin.latestReview ? await response.text() : undefined;
          reviewingMetadata = pin.latestReview !== undefined;
          const body: unknown = text === undefined ? await response.json() : JSON.parse(text);
          let pinnedBody: unknown;
          if (pin.registry === "pypi" && pin.latestReview !== undefined) {
            // Validate the latest document before another network operation can
            // fail: malformed published metadata must not become an offline warning.
            const latest = object(body);
            const preflight = compareLatestReview(pin, body, {
              info: { version: pin.version, yanked: false },
              urls: object(latest.releases)[pin.version],
            });
            if (preflight.status !== "current") {
              findings.push({ provider: task.provider, package: pin.name, ...preflight });
              continue;
            }
            reviewingMetadata = false;
            const pinnedResponse = await fetcher(
              `https://pypi.org/pypi/${encodeURIComponent(pin.name)}/${encodeURIComponent(pin.version)}/json`,
              {
                signal: AbortSignal.timeout(10_000),
                redirect: "error",
              },
            );
            if (!pinnedResponse.ok)
              throw new Error(`Pinned registry returned HTTP ${pinnedResponse.status}`);
            const pinnedText = await pinnedResponse.text();
            reviewingMetadata = true;
            pinnedBody = JSON.parse(pinnedText);
          }
          findings.push({
            provider: task.provider,
            package: pin.name,
            ...(pin.latestReview
              ? compareLatestReview(pin, body, pinnedBody)
              : line
                ? compareSupportedLine(pin, body)
                : compareRelease(pin, body)),
          });
        } catch (error) {
          findings.push({
            provider: task.provider,
            package: pin.name,
            status: reviewingMetadata ? "review" : "unavailable",
            message: error instanceof Error ? error.message : "Registry check failed",
          });
        }
      }
    }),
  );
  return findings.sort((a, b) =>
    `${a.provider}/${a.package}`.localeCompare(`${b.provider}/${b.package}`),
  );
}

if (import.meta.main) {
  try {
    const lock = validateLock(
      JSON.parse(readFileSync(new URL("../compatibility-lock.json", import.meta.url), "utf8")),
    );
    const findings = await checkUpstreams(lock);
    for (const item of findings)
      console.log(`[${item.status}] ${item.provider} / ${item.package}: ${item.message}`);
    if (findings.some((item) => item.status !== "current")) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
