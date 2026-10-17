// What each registry already has, and whether a version may go to it (Marc,
// 14 October 2026: agents publish the SDKs by themselves). The hub asks this
// before it starts a release (agents/sdks.ts), and each job of the publish
// workflow asks it again just before its upload (cli.ts decide). A version
// the registry has is skipped: none takes one twice, and a rerun finishes
// what a run left. A version at or below the registry's newest is refused:
// npm would move `latest` backwards, and the others would list a release
// older than one customers already have. Node runs this file in the public
// mirror with its types stripped: it imports nothing.

export type Target = "npm" | "mcp" | "pypi" | "langchain" | "maven" | "rubygems" | "go";
export const TARGETS: readonly Target[] = [
  "npm",
  "mcp",
  "pypi",
  "langchain",
  "maven",
  "rubygems",
  "go",
];

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Registry = {
  /** The package whose version files name the version (versions.ts). */
  pkg: "js" | "python" | "langchain" | "go" | "java" | "ruby";
  /** In plain words, for Slack and the logs. */
  label: string;
  /** Every version it lists, or why it could not be read; a package it has
   * never heard of lists none. */
  read(fetcher: Fetch): Promise<string[] | { unread: string }>;
};

/** Tries a read takes: a cut connection or a registry's passing 5xx or 429
 * is read again (a GET), each try within its own time limit. On 15 October
 * 2026 one cut read ("socket connection was closed unexpectedly") was the
 * hub's whole SDK step for that tick, while npm answered in 0.1 s. */
export const READ_TRIES = 3;
export const READ_TIMEOUT = 30_000;
/** The wait between tries; the tests set it to nothing. */
export const reading = { pause: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

async function get(
  fetcher: Fetch,
  url: string,
  as: "json" | "text",
): Promise<{ missing: true } | { unread: string } | { body: any }> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= READ_TRIES;
    try {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(READ_TIMEOUT),
        headers: { accept: as === "json" ? "application/json" : "text/plain, application/xml" },
      });
      if (response.status === 404 || response.status === 410) return { missing: true as const };
      if ((response.status >= 500 || response.status === 429) && !last) {
        await reading.pause(1000 * attempt);
        continue;
      }
      if (!response.ok) return { unread: `${url} answered ${response.status}` };
      return { body: as === "json" ? ((await response.json()) as any) : await response.text() };
    } catch (error) {
      if (last) throw error;
      await reading.pause(1000 * attempt);
    }
  }
}

function reader(url: string, as: "json" | "text", parse: (body: any) => unknown) {
  return async (fetcher: Fetch): Promise<string[] | { unread: string }> => {
    try {
      const r = await get(fetcher, url, as);
      if ("missing" in r) return [];
      if ("unread" in r) return { unread: r.unread };
      const list = parse(r.body);
      if (!Array.isArray(list) || list.some((v) => typeof v !== "string"))
        return { unread: `${url} answered something else` };
      return list as string[];
    } catch (error) {
      return { unread: `${url}: ${(error as Error).message}` };
    }
  };
}

const MCP_NAME = "com.withruntime/runtime";

/** Every version the MCP registry lists for the server, page by page. */
async function mcpVersions(fetcher: Fetch): Promise<string[] | { unread: string }> {
  const versions: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(MCP_NAME)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    try {
      const r = await get(fetcher, url, "json");
      if ("missing" in r) return versions;
      if ("unread" in r) return { unread: r.unread };
      const servers = r.body?.servers;
      if (!Array.isArray(servers)) return { unread: `${url} answered something else` };
      for (const s of servers) {
        // The registry's answer since its 2025-12 schema wraps each in
        // `server`; before, the fields were at the top.
        const server = s?.server ?? s;
        if (server?.name === MCP_NAME && typeof server.version === "string")
          versions.push(server.version);
      }
      cursor = r.body?.metadata?.nextCursor || r.body?.metadata?.next_cursor || undefined;
      if (!cursor) return versions;
    } catch (error) {
      return { unread: `${url}: ${(error as Error).message}` };
    }
  }
  return { unread: "the MCP registry listed more than 10 pages" };
}

export const REGISTRIES: Record<Target, Registry> = {
  npm: {
    pkg: "js",
    label: "npm withruntime",
    read: reader("https://registry.npmjs.org/withruntime", "json", (b) =>
      Object.keys(b?.versions ?? {}),
    ),
  },
  mcp: { pkg: "js", label: "the MCP registry (com.withruntime/runtime)", read: mcpVersions },
  pypi: {
    pkg: "python",
    label: "PyPI withruntime",
    read: reader("https://pypi.org/pypi/withruntime/json", "json", (b) =>
      Object.keys(b?.releases ?? {}),
    ),
  },
  langchain: {
    pkg: "langchain",
    label: "PyPI langchain-withruntime",
    read: reader("https://pypi.org/pypi/langchain-withruntime/json", "json", (b) =>
      Object.keys(b?.releases ?? {}),
    ),
  },
  maven: {
    pkg: "java",
    label: "Maven Central com.withruntime:withruntime",
    read: reader(
      "https://repo1.maven.org/maven2/com/withruntime/withruntime/maven-metadata.xml",
      "text",
      (b) => [...String(b).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]),
    ),
  },
  rubygems: {
    pkg: "ruby",
    label: "RubyGems withruntime",
    read: reader("https://rubygems.org/api/v1/versions/withruntime.json", "json", (b) =>
      Array.isArray(b) ? b.map((v) => v?.number) : undefined,
    ),
  },
  go: {
    pkg: "go",
    label: "Go withruntime.com/go",
    read: reader("https://proxy.golang.org/withruntime.com/go/@v/list", "text", (b) =>
      String(b)
        .split("\n")
        .map((v) => v.trim().replace(/^v/, ""))
        .filter(Boolean),
    ),
  },
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Orders two versions as semver does (a leading v ignored). */
export function compare(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split(/-(.*)/s);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export type Decision = { do: "publish" } | { do: "skip" } | { refused: string };

/** Whether `version` goes to a registry that lists `published`. */
export function decide(
  version: string,
  published: readonly string[],
  label = "the registry",
): Decision {
  if (!SEMVER.test(version)) return { refused: `${version} is not X.Y.Z` };
  if (published.includes(version)) return { do: "skip" };
  const newest = [...published].sort(compare).at(-1);
  if (newest !== undefined && compare(version, newest) <= 0)
    return {
      refused: `${version} is not newer than ${newest}, the newest ${label} has: bump the version past it`,
    };
  return { do: "publish" };
}

/** The registry each client the API names (packages/cloud/src/api/client-version.ts)
 * installs from. */
export const CLIENT_TARGETS: Record<string, Target> = {
  "sdk-js": "npm",
  "mcp-bridge": "npm",
  "sdk-python": "pypi",
  "sdk-go": "go",
  "sdk-java": "maven",
  "sdk-ruby": "rubygems",
};

/** The cutoffs client-version.ts's KNOWS names, read from its text: the hub
 * reads them from the commit it publishes, and loads nothing of the API. */
export function parseKnows(text: string): Record<string, readonly number[]> {
  const block = /const KNOWS[^{]*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/"([a-z-]+)": \[(\d+), (\d+), (\d+)\]/g)].map(([, client, ...v]) => [
      client!,
      v.map(Number),
    ]),
  );
}

/** Why a registry's customers cannot install a client the API counts as
 * knowing that a stop keeps the disk (`knows`: client-version.ts KNOWS), or
 * undefined. On 15 October 2026 PyPI's newest was 0.11.1 against the API's
 * 0.12.0, so every Python customer's stop deleted the disk three days later,
 * with nothing to install instead. */
export function behindCutoff(
  target: Target,
  knows: Record<string, readonly number[]>,
  listed: readonly string[],
): string | undefined {
  const first = Object.entries(CLIENT_TARGETS)
    .filter(([client, t]) => t === target && knows[client])
    .map(([client]) => knows[client]!.join("."))
    .sort(compare)
    .at(-1);
  if (!first) return undefined;
  const newest = [...listed].sort(compare).at(-1);
  if (newest && compare(newest, first) >= 0) return undefined;
  return `${REGISTRIES[target].label} has ${newest ?? "no version"}, below ${first}, the first the API counts as knowing that a stop keeps the disk: its customers' stops delete the disk after three days`;
}
