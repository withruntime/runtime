/** CLOUD.md section 4: one plural word per product on every interface
 * (6 October 2026). The API path `/v1/<name>`, the SDK's `runtime.<name>`, the
 * CLI's `runtime <name>` and the MCP's `runtime_<name>` all use `name` below;
 * the CLI also takes `singular` as a typing shortcut, and nothing else does.
 *
 * An old name keeps working for ALIAS_DAYS after the rename ships, with a
 * warning naming the new one, then fails with `name_retired` and a hint. Its
 * `retires` is null until the deploy that ships the rename sets it: the date
 * is the deploy's, never a guess made before it.
 *
 * This is the one table of product names. PRODUCT_LAUNCHES in mcp-groups.ts
 * says whether a product is open; this says what it is called. */

export const ALIAS_DAYS = 30;

/** CLOUD.md section 2's seven engines. */
export type Engine = "machine" | "disk" | "record" | "address" | "identity" | "meter" | "database";

export type OldName = {
  /** The old word, as it appeared on any interface: `sandbox` stands for
   * `/v1/sandbox`, `runtime.sandbox`, `runtime sandbox` and
   * `runtime_sandbox_*`. Separators are compared as one (`-` and `_`). */
  readonly name: string;
  /** ISO date (UTC midnight) on which the old name stops working; null until
   * the rename's deploy sets it to that day plus ALIAS_DAYS. */
  readonly retires: string | null;
  /** Where the old word's things now live inside the product, when not at
   * its root: the WireGuard tunnel was `tunnel` and is `networks/wireguard`,
   * leaving `/v1/networks` free to list private networks. */
  readonly under?: string;
};

export type ProductName = {
  /** The plural word on every interface. */
  readonly name: string;
  /** What a customer reads in a title. */
  readonly title: string;
  readonly engine: Engine;
  /** The CLI-only shortcut; absent when the name has no singular. */
  readonly singular?: string;
  readonly old: readonly OldName[];
};

/** The batch of 6 October 2026: shared by every old name it retired. Set at
 * its deploy to that day plus ALIAS_DAYS. */
const RENAME_OF_6_OCTOBER: string | null = null;

const was = (...names: string[]): OldName[] =>
  names.map((name) => ({ name, retires: RENAME_OF_6_OCTOBER }));

/** Every product, in CLOUD.md section 2's order. Old names are only the ones a
 * customer could have called: a planned name that never shipped has none. */
export const PRODUCT_NAMES: readonly ProductName[] = [
  // Machine
  {
    name: "sandboxes",
    title: "Sandboxes",
    engine: "machine",
    singular: "sandbox",
    old: was("sandbox"),
  },
  { name: "browsers", title: "Browsers", engine: "machine", singular: "browser", old: [] },
  { name: "desktops", title: "Desktops", engine: "machine", singular: "desktop", old: [] },
  { name: "apps", title: "Apps", engine: "machine", singular: "app", old: [] },
  { name: "functions", title: "Functions", engine: "machine", singular: "function", old: [] },
  { name: "containers", title: "Containers", engine: "machine", singular: "container", old: [] },
  { name: "jobs", title: "Jobs", engine: "machine", singular: "job", old: was("job") },
  { name: "workflows", title: "Workflows", engine: "machine", singular: "workflow", old: [] },
  { name: "builds", title: "Builds", engine: "machine", singular: "build", old: [] },
  { name: "agents", title: "Agents", engine: "machine", singular: "agent", old: [] },
  { name: "ci", title: "CI/CD", engine: "machine", old: [] },
  // Disk
  { name: "volumes", title: "Volumes", engine: "disk", singular: "volume", old: was("volume") },
  {
    name: "snapshots",
    title: "Snapshots",
    engine: "disk",
    singular: "snapshot",
    old: was("snapshot"),
  },
  { name: "images", title: "Images", engine: "disk", singular: "image", old: was("image") },
  { name: "buckets", title: "Buckets", engine: "disk", singular: "bucket", old: [] },
  { name: "backups", title: "Backups", engine: "disk", singular: "backup", old: [] },
  // Record
  { name: "queues", title: "Queues", engine: "record", singular: "queue", old: [] },
  { name: "streams", title: "Streams", engine: "record", singular: "stream", old: [] },
  { name: "realtime", title: "Realtime", engine: "record", old: [] },
  { name: "events", title: "Events", engine: "record", old: [] },
  { name: "webhooks", title: "Webhooks", engine: "record", singular: "webhook", old: [] },
  { name: "logs", title: "Logs", engine: "record", singular: "log", old: [] },
  { name: "traces", title: "Traces", engine: "record", singular: "trace", old: [] },
  { name: "alerts", title: "Alerts", engine: "record", singular: "alert", old: [] },
  // Address. `networks` is the private network, which the guides called
  // `runtime tunnel` (WireGuard) and `runtime network`; `tunnels` is incoming
  // tunnels, ngrok's kind. Static IPs were `runtime address`.
  { name: "domains", title: "Domains", engine: "address", singular: "domain", old: was("domain") },
  { name: "dns", title: "DNS", engine: "address", old: [] },
  { name: "balancers", title: "Load balancers", engine: "address", singular: "balancer", old: [] },
  { name: "cdn", title: "CDN", engine: "address", old: [] },
  {
    name: "networks",
    title: "Private networks",
    engine: "address",
    singular: "network",
    old: [...was("network"), { name: "tunnel", retires: RENAME_OF_6_OCTOBER, under: "wireguard" }],
  },
  { name: "tunnels", title: "Tunnels", engine: "address", singular: "tunnel", old: [] },
  {
    name: "ips",
    title: "Static IPs",
    engine: "address",
    singular: "ip",
    old: was("address", "addresses"),
  },
  { name: "ports", title: "Public ports", engine: "address", singular: "port", old: was("port") },
  { name: "firewall", title: "Firewall", engine: "address", old: [] },
  { name: "uptime", title: "Uptime checks", engine: "address", old: [] },
  // Identity
  { name: "teams", title: "Teams", engine: "identity", singular: "team", old: [] },
  { name: "keys", title: "API keys", engine: "identity", singular: "key", old: [] },
  { name: "sso", title: "Single sign-on", engine: "identity", old: [] },
  { name: "secrets", title: "Secrets", engine: "identity", singular: "secret", old: [] },
  { name: "audit", title: "Audit log", engine: "identity", old: [] },
  { name: "tokens", title: "Identity tokens", engine: "identity", singular: "token", old: [] },
  // Meter
  { name: "usage", title: "Usage", engine: "meter", old: [] },
  { name: "billing", title: "Billing", engine: "meter", old: [] },
  { name: "metrics", title: "Metrics", engine: "meter", old: [] },
  { name: "plans", title: "Plans", engine: "meter", singular: "plan", old: [] },
  // Database (not now: CLOUD.md section 2)
  { name: "postgres", title: "Postgres", engine: "database", old: [] },
  { name: "mysql", title: "MySQL", engine: "database", old: [] },
  { name: "redis", title: "Redis", engine: "database", old: [] },
  { name: "vector", title: "Vector", engine: "database", old: [] },
  { name: "search", title: "Search", engine: "database", old: [] },
  { name: "analytics", title: "Analytics", engine: "database", old: [] },
  { name: "web-analytics", title: "Web analytics", engine: "database", old: [] },
];

/** CLOUD.md section 4: what spans products, at the top level, as it is. */
export const TOP_LEVEL: readonly string[] = [
  "account",
  "billing",
  "usage",
  "compare",
  "keys",
  "secrets",
  "events",
  "webhooks",
  "ls",
  "feedback",
  "support",
];

/** `-` and `_` are one separator: the API path says `web-analytics`, the MCP
 * tool `runtime_web_analytics`. */
export function wordOf(name: string): string {
  return name.toLowerCase().replaceAll("_", "-");
}

/** The table's own rules: each word means one thing. No shortcut or old name
 * is a product's name. An old name may equal a shortcut: its own product's
 * (`sandbox`, silent in the CLI, a warning elsewhere) or another's (`tunnel`,
 * whose old name wins until it retires, and then the shortcut takes over).
 * Returns the problems found. */
export function validateProductNames(table: readonly ProductName[] = PRODUCT_NAMES): string[] {
  const problems: string[] = [];
  const current = new Map<string, string>();
  for (const product of table) {
    const word = wordOf(product.name);
    if (word !== product.name) problems.push(`${product.name}: write the name in its API form`);
    if (current.has(word)) problems.push(`${word}: named twice`);
    current.set(word, product.name);
  }
  const shortcuts = new Map<string, string>();
  for (const product of table) {
    if (!product.singular) continue;
    const word = wordOf(product.singular);
    if (current.has(word)) problems.push(`${product.name}: shortcut ${word} is a product's name`);
    if (shortcuts.has(word)) problems.push(`${word}: shortcut of two products`);
    shortcuts.set(word, product.name);
  }
  const olds = new Set<string>();
  for (const product of table) {
    for (const old of product.old) {
      const word = wordOf(old.name);
      if (current.has(word)) problems.push(`${product.name}: old name ${word} is a product's name`);
      if (olds.has(word)) problems.push(`${word}: old name of two products`);
      if (old.retires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(old.retires)) {
        problems.push(`${word}: retires must be a date, YYYY-MM-DD`);
      }
      olds.add(word);
    }
  }
  return problems;
}
