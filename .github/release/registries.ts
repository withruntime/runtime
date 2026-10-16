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

async function get(
  fetcher: Fetch,
  url: string,
  as: "json" | "text",
): Promise<{ missing: true } | { unread: string } | { body: any }> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: as === "json" ? "application/json" : "text/plain, application/xml" },
  });
  if (response.status === 404 || response.status === 410) return { missing: true as const };
  if (!response.ok) return { unread: `${url} answered ${response.status}` };
  return { body: as === "json" ? ((await response.json()) as any) : await response.text() };
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

function compare(a: string, b: string): number {
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
