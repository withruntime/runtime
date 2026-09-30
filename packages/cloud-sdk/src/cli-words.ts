import type { RuntimeError } from "./errors.js";
import type { SandboxMetrics } from "./products/observability.js";

/* What the CLI says in its own words where the API's would mislead: the
   option a refusal is about rather than the request field it was sent as,
   one fact a line for a resource read, and the newest CPU reading a
   sandbox's metrics hold. Kept out of cli.ts, which many hands edit. */

/** The request fields a command line sets, by the option that sets them.
 * An amount in microdollars is typed in dollars. */
const OPTIONS: Record<string, { flag: string; micros?: true }> = {
  name: { flag: "--name" },
  labels: { flag: "--label" },
  env: { flag: "--env" },
  region: { flag: "--region" },
  vcpu: { flag: "--vcpu" },
  memoryMiB: { flag: "--memory" },
  diskMiB: { flag: "--disk" },
  cpu: { flag: "--cpu" },
  cpuFloorMillis: { flag: "--cpu-floor" },
  timeoutSeconds: { flag: "--timeout" },
  onLeaseEnd: { flag: "--on-timeout" },
  idlePauseSeconds: { flag: "--idle-pause" },
  autoWake: { flag: "--no-auto-wake / --auto-wake" },
  persistent: { flag: "--persistent" },
  funding: { flag: "--trial / --paid" },
  image: { flag: "--image" },
  snapshot: { flag: "--snapshot" },
  volumes: { flag: "--volume" },
  network: { flag: "--allow / --deny / --connect / --no-internet" },
  maxCostMicros: { flag: "--max-cost", micros: true },
  maxTotalCostMicros: { flag: "--max-total-cost", micros: true },
};

const usd = (micros: number) =>
  `$${(micros / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

/** One issue the API found in a request, in the command line's words:
 * `body.timeoutSeconds must be at least 60` is `--timeout must be at least 60`. */
function issueWords(path: string, message: string): string {
  const field = /^(?:\$\.)?body\.([A-Za-z]+)/.exec(path)?.[1];
  const option = field && Object.hasOwn(OPTIONS, field) ? OPTIONS[field] : undefined;
  if (!option) {
    const where = path.replace(/^\$\.?/, "").replace(/^(body|query|path)\./, "") || "the request";
    return `${where} ${message}`;
  }
  const said = option.micros ? message.replace(/-?\d+(?:\.\d+)?/g, (n) => usd(Number(n))) : message;
  return `${option.flag} ${said}`;
}

/** A refusal of what a command sent, reworded for the command line: every
 * issue named by its option, since the CLI never prints details.issues, and
 * a hint that names the options rather than the request's fields. Anything
 * else is left as the API said it. */
export function cliRefusal(error: RuntimeError): { message: string; hint?: string } {
  const issues = error.details?.issues;
  if (error.code === "invalid_request" && Array.isArray(issues) && issues.length) {
    const lines = (issues as Array<{ path?: unknown; message?: unknown }>)
      .filter((i) => typeof i.path === "string" && typeof i.message === "string")
      .map((i) => issueWords(i.path as string, i.message as string));
    if (lines.length)
      return {
        message: lines.length === 1 ? `${lines[0]}.` : lines.map((l) => `\n  ${l}`).join(""),
        hint: "Change what is named above and run the command again.",
      };
  }
  const field = typeof error.details?.field === "string" ? error.details.field : "";
  const option = Object.hasOwn(OPTIONS, field) ? OPTIONS[field] : undefined;
  if (option && !option.micros && error.message.includes(field)) {
    const named = new RegExp(`\\b${field}\\b`, "g");
    return {
      message: error.message.replace(named, option.flag),
      ...(error.hint ? { hint: error.hint.replace(named, option.flag) } : {}),
    };
  }
  return { message: error.message, ...(error.hint ? { hint: error.hint } : {}) };
}

/** A resource read as one fact a line, as `sandbox get` prints: a list
 * joined, a nested record as its own facts, nothing as `-`. */
export function describeRecord(
  record: Record<string, unknown>,
  table: (rows: string[][]) => string,
): string {
  const rows: string[][] = [];
  const cell = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "-";
    if (Array.isArray(value))
      return value.length
        ? value.map((v) => (v && typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")
        : "-";
    // A string as it is; a number, a boolean or a record as JSON writes it.
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  const add = (prefix: string, value: Record<string, unknown>) => {
    for (const [key, v] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 8)
        add(name, v as Record<string, unknown>);
      else rows.push([name, cell(v)]);
    }
  };
  add("", record);
  return table(rows);
}

/** The newest CPU reading the metrics hold, and how old it is. `latest` is
 * the last sample, which can carry no CPU figure (the first after a wake has
 * nothing to compare with), while the points before it do; "no reading"
 * above a sparkline of readings contradicted itself. */
export function newestCpu(
  m: SandboxMetrics,
  now = Date.now(),
): { percent: number; cores: number | null; ago: string | null } | null {
  if (m.latest?.cpuPercent != null)
    return { percent: m.latest.cpuPercent, cores: m.latest.cpuCores, ago: null };
  for (let i = m.points.length - 1; i >= 0; i--) {
    const p = m.points[i]!;
    if (p.cpuPercent == null) continue;
    const seconds = Math.max(0, Math.round((now - Date.parse(p.at)) / 1000));
    const ago =
      seconds < 90
        ? `${seconds} s ago`
        : seconds < 5400
          ? `${Math.round(seconds / 60)} min ago`
          : `${Math.round(seconds / 3600)} h ago`;
    return { percent: p.cpuPercent, cores: p.cpuCores, ago };
  }
  return null;
}

/** The lines of the top-level help about one command, `  feedback ...` and
 * the lines that continue it, or null when it has none. `runtime feedback
 * help` filed "help" as feedback, and `runtime support help` sent it to
 * support, until 30 September 2026. */
export function topicHelp(help: string, command: string): string | null {
  const lines = help.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const starts = line.startsWith(`  ${command} `) || line === `  ${command}`;
    if (starts) inside = true;
    else if (inside && !/^ {3,}\S/.test(line)) inside = false;
    if (inside) out.push(line);
  }
  return out.length ? out.join("\n") : null;
}
