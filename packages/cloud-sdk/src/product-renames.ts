/** CLOUD.md section 4: an old product word keeps working for ALIAS_DAYS after
 * its rename ships, with a warning naming the new word, and then fails with
 * `name_retired` and a hint. One implementation for the API's paths, the MCP's
 * tool names, the CLI's commands and the SDK's properties; each reads the table in
 * product-names.ts. This file imports nothing else, so the CLI can carry it. */
import { ALIAS_DAYS, PRODUCT_NAMES, wordOf, type ProductName } from "./product-names.js";

export type Surface = "api" | "mcp" | "cli" | "sdk";

export type RetiredName = {
  readonly code: "name_retired";
  readonly status: 410;
  readonly message: string;
  readonly hint: string;
};

/** CLOUD.md section 4: the deploy shipping this batch sets its retirement
 * date to the deploy day plus ALIAS_DAYS, as product-names.ts does. */
const RENAME_OF_8_OCTOBER: string | null = null;

export type RenamedField = {
  readonly name: "pot" | "potLimits";
  readonly now: "startupIncluded" | "startupLimits";
  readonly where: "GET /v1/usage";
  readonly retires: string | null;
};

/** Response fields follow the same 30-day rule as product names. */
export const RENAMED_FIELDS: readonly RenamedField[] = [
  { name: "pot", now: "startupIncluded", where: "GET /v1/usage", retires: RENAME_OF_8_OCTOBER },
  { name: "potLimits", now: "startupLimits", where: "GET /v1/usage", retires: RENAME_OF_8_OCTOBER },
];

/** CLOUD.md section 4: warn while a response field's old name works, then
 * fail with the same code, status and hint as a retired product name. */
export function fieldUse(
  name: RenamedField["name"],
  now: Date = new Date(),
  table: readonly RenamedField[] = RENAMED_FIELDS,
): { kind: "renamed"; warning: string } | { kind: "retired"; error: RetiredName } {
  const field = table.find((field) => field.name === name);
  if (!field) throw new Error(`Unknown renamed response field: ${name}`);
  const from = `usage.${field.name}`;
  const to = `usage.${field.now}`;
  if (isRetired(field.retires, now))
    return {
      kind: "retired",
      error: {
        code: RETIRED[0],
        status: RETIRED[1],
        message: `${from} was renamed ${to} and stopped working on ${field.retires}.`,
        hint: `Use ${to}.`,
      },
    };
  const by = field.retires === null ? "" : ` It stops working on ${field.retires}.`;
  return { kind: "renamed", warning: `${from} is now ${to}.${by}` };
}

export type NameUse =
  /** The product's own word, or in the CLI its singular shortcut. */
  | { readonly kind: "current"; readonly product: ProductName }
  /** An old word, still served: say `warning` to the caller. */
  | {
      readonly kind: "renamed";
      readonly product: ProductName;
      readonly old: string;
      /** The new words, `networks/wireguard` for `tunnel`. */
      readonly to: string;
      readonly retires: string | null;
      readonly warning: string;
    }
  /** An old word past its date. */
  | {
      readonly kind: "retired";
      readonly product: ProductName;
      readonly old: string;
      readonly to: string;
      readonly error: RetiredName;
    };

/** The new words for an old one: the product, then where inside it. */
export function newWords(product: string, under?: string): string {
  return under === undefined ? product : `${product}/${under}`;
}

/** How each surface writes product words (`networks/wireguard`), for
 * messages. */
function spelled(words: string, surface: Surface): string {
  if (surface === "api") return `/v1/${words}`;
  if (surface === "mcp") return `runtime_${words.replaceAll(/[-/]/g, "_")}`;
  if (surface === "sdk") return `runtime.${sdkPath(words).join(".")}`;
  return `runtime ${words.replaceAll("/", " ")}`;
}

/** The property path of product words in the JavaScript SDK:
 * `networks/wireguard` is `networks.wireguard`, `web-analytics` is
 * `webAnalytics`. */
export function sdkPath(words: string): string[] {
  return words
    .split("/")
    .map((word) => word.replaceAll(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase()));
}

/** Whether `retires` (a UTC date) has come at `now`. */
export function isRetired(retires: string | null, now: Date): boolean {
  return retires !== null && now.getTime() >= Date.parse(`${retires}T00:00:00Z`);
}

/** The code and status of an old word after its date (api.md's table). */
const RETIRED = ["name_retired", 410] as const;

/** What one word means on one surface at `now`, or undefined when it names no
 * product. The CLI takes a product's singular silently, unless the word is
 * still another product's live old name (`tunnel` names the private network
 * until it retires, then incoming tunnels). */
export function resolveWord(
  word: string,
  surface: Surface,
  now: Date = new Date(),
  table: readonly ProductName[] = PRODUCT_NAMES,
): NameUse | undefined {
  const asked = wordOf(word);
  const own = table.find((product) => product.name === asked);
  if (own) return { kind: "current", product: own };
  let retired: NameUse | undefined;
  for (const product of table) {
    for (const old of product.old) {
      if (wordOf(old.name) !== asked) continue;
      if (surface === "cli" && product.singular === asked) return { kind: "current", product };
      const to = newWords(product.name, old.under);
      const target = spelled(to, surface);
      if (!isRetired(old.retires, now)) {
        const by = old.retires === null ? "" : ` It stops working on ${old.retires}.`;
        return {
          kind: "renamed",
          product,
          old: asked,
          to,
          retires: old.retires,
          warning: `${spelled(asked, surface)} is now ${target}.${by}`,
        };
      }
      retired = {
        kind: "retired",
        product,
        old: asked,
        to,
        error: {
          code: RETIRED[0],
          status: RETIRED[1],
          message: `${spelled(asked, surface)} was renamed ${target} and stopped working on ${old.retires}.`,
          hint: `Use ${target}.`,
        },
      };
    }
  }
  if (surface === "cli") {
    const shortcut = table.find((product) => product.singular === asked);
    if (shortcut) return { kind: "current", product: shortcut };
  }
  return retired;
}

/** An API path under an old word, rewritten to the new one: `/v1/addresses/x`
 * is `/v1/ips/x`. Undefined when the path's first word is not an old name. */
export function renamePath(
  pathname: string,
  now: Date = new Date(),
  table: readonly ProductName[] = PRODUCT_NAMES,
): { readonly path: string; readonly use: Exclude<NameUse, { kind: "current" }> } | undefined {
  const found = /^\/v1\/([a-z][a-z0-9_-]*)(?=\/|:|$)/.exec(pathname);
  if (!found) return undefined;
  const use = resolveWord(found[1]!, "api", now, table);
  if (!use || use.kind === "current") return undefined;
  return { path: `/v1/${use.to}${pathname.slice(found[0].length)}`, use };
}

/** An MCP tool under an old word, renamed: `runtime_sandbox_exec` is
 * `runtime_sandboxes_exec`. The longest old word wins, so `runtime_web_x`
 * never takes a shorter old name's place. */
export function renameTool(
  tool: string,
  now: Date = new Date(),
  table: readonly ProductName[] = PRODUCT_NAMES,
): { readonly tool: string; readonly use: Exclude<NameUse, { kind: "current" }> } | undefined {
  if (!tool.startsWith("runtime_")) return undefined;
  const rest = tool.slice("runtime_".length);
  let best: { word: string; use: Exclude<NameUse, { kind: "current" }> } | undefined;
  for (const product of table) {
    for (const old of product.old) {
      const word = wordOf(old.name).replaceAll("-", "_");
      if (rest !== word && !rest.startsWith(`${word}_`)) continue;
      if (best && best.word.length >= word.length) continue;
      const use = resolveWord(word, "mcp", now, table);
      if (use && use.kind !== "current") best = { word, use };
    }
  }
  if (!best) return undefined;
  const renamed = `${spelled(best.use.to, "mcp")}${rest.slice(best.word.length)}`;
  return { tool: renamed, use: best.use };
}

/** The headers an answer under an old path carries: `Deprecation` (RFC 9745)
 * from the day the rename shipped, `Sunset` (RFC 8594) on the day it stops,
 * a `Link` to the new path, and `Warning` with the sentence the SDK and CLI
 * print. */
export function renamedHeaders(renamed: {
  readonly path: string;
  readonly use: NameUse;
}): Record<string, string> {
  const { use } = renamed;
  if (use.kind !== "renamed") return {};
  const headers: Record<string, string> = {
    warning: `299 runtime "${use.warning.replaceAll('"', "'")}"`,
    link: `<${renamed.path}>; rel="successor-version"`,
  };
  if (use.retires !== null) {
    const ends = Date.parse(`${use.retires}T00:00:00Z`);
    headers.deprecation = `@${Math.floor((ends - ALIAS_DAYS * 86_400_000) / 1000)}`;
    headers.sunset = new Date(ends).toUTCString();
  }
  return headers;
}

/** The sentence inside a `Warning: 299` header, for the SDK and CLI to print;
 * undefined for any other header. */
export function warningText(header: string | null): string | undefined {
  const found = header === null ? null : /^299 \S+ "(.*)"$/.exec(header);
  return found ? found[1] : undefined;
}

/** A CLI command line's product words, in their plural form: `sandbox ls` is
 * `sandboxes ls` silently, and `tunnel create` is `networks wireguard create`
 * with the warning to print. Undefined when the first word names no product,
 * so a top-level command (`login`, `ls`) passes through. */
export function cliWords(
  args: readonly string[],
  now: Date = new Date(),
  table: readonly ProductName[] = PRODUCT_NAMES,
): { readonly args: string[]; readonly use: NameUse } | undefined {
  const [first, ...rest] = args;
  if (first === undefined) return undefined;
  const use = resolveWord(first, "cli", now, table);
  if (!use) return undefined;
  const words = use.kind === "current" ? use.product.name : use.to;
  return { args: [...words.split("/"), ...rest], use };
}
