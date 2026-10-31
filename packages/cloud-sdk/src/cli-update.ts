// An option or command the CLI refuses may be one a newer CLI has: on 26
// October 2026 `secrets scope --only-label` was refused as an unknown option
// by a withruntime 0.12.0 installed globally, which `npx withruntime` runs
// before it fetches the latest (0.37.0 had the option). So a usage error
// asks npm for the latest version, once and briefly, and says when this CLI
// is older. Nothing is asked on any other path, in CI, or when
// RUNTIME_NO_UPDATE_CHECK is set.
import { envFetch } from "./proxy.js";
import { timeoutSignal, VERSION } from "./transport.js";

export const LATEST_URL = "https://registry.npmjs.org/withruntime/latest";
const ASK_MS = 1_500;

const parts = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);

/** Whether `latest` is a later release than `current`. A pre-release or a
 * version that is not x.y.z is never later. */
export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The line said under a usage error when npm has a later CLI, or "". */
export async function outdatedLine(opts: {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  version?: string;
  timeoutMs?: number;
}): Promise<string> {
  const { env } = opts;
  if (env.RUNTIME_NO_UPDATE_CHECK || env.CI) return "";
  const current = opts.version ?? VERSION;
  try {
    const response = await (opts.fetch ?? envFetch)(LATEST_URL, {
      headers: { accept: "application/json" },
      signal: timeoutSignal(opts.timeoutMs ?? ASK_MS),
    });
    if (!response.ok) return "";
    const latest = ((await response.json()) as { version?: unknown }).version;
    if (typeof latest !== "string" || !isNewer(latest, current)) return "";
    return `Note: this CLI is withruntime ${current} and the latest is ${latest}, which may support this. Update with \`npm install -g withruntime@latest\`, or run the latest once with \`npx withruntime@latest\` (plain \`npx withruntime\` runs an installed copy first).`;
  } catch {
    return "";
  }
}
