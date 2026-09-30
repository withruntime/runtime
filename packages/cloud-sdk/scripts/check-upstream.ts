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
        try {
          const line = pin.unsupported !== undefined;
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
          const body: unknown = await response.json();
          findings.push({
            provider: task.provider,
            package: pin.name,
            ...(line ? compareSupportedLine(pin, body) : compareRelease(pin, body)),
          });
        } catch (error) {
          findings.push({
            provider: task.provider,
            package: pin.name,
            status: "unavailable",
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
