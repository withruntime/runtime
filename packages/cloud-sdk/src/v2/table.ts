/* The CLI's commands, read from the API's own description (GET
   /v2/openapi.json, which the server makes from the spec it serves), so a
   verb is a command the moment it is live, with no new release. The
   document is kept on disk with its ETag, checked in one round trip on each
   start, and the copy shipped in the package is used when neither answers. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One flag: a field of a verb's query or body, or a shortcut's argument. */
export interface Flag {
  flag: string;
  field: string;
  type: string;
  list: boolean;
  /** A command (text run by bash -lc, or a list run without a shell): what follows `--` on the command line. */
  command?: boolean;
  required: boolean;
  doc: string;
}

/** `runtime <product> <verb>`, or a shortcut's `runtime <name>`. */
export interface Command {
  /** `sandboxes.create`, or the shortcut's name. */
  name: string;
  product: string;
  verb: string;
  doc: string;
  /** Its positional arguments: its path's parts, in order. */
  args: string[];
  flags: Flag[];
  /** Its body is the bytes on standard input. */
  stdin: boolean;
  shortcut?: Shortcut;
}

export interface Step {
  verb: string;
  args: Record<string, { arg: string } | { step: number; field: string }>;
  always: boolean;
}

export interface Shortcut {
  name: string;
  description: string;
  steps: Step[];
  answer: number;
}

/** `getNetwork` as `get-network`. */
export function kebab(name: string): string {
  return name.replace(/MiB/g, "Mib").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

type Schema = Record<string, any>;

function resolve(doc: Schema, s: Schema | undefined): Schema {
  const ref = s?.["$ref"];
  return typeof ref === "string" ? (ref.replace(/^#\//, "").split("/").reduce((o: any, k) => o?.[k], doc) ?? {}) : (s ?? {});
}

function flagsOf(props: Record<string, Schema>, required: string[], skip: string[]): Flag[] {
  return Object.entries(props)
    .filter(([name]) => !skip.includes(name))
    .map(([name, s]) => ({
      flag: kebab(name),
      field: name,
      type: s["type"] === "array" ? (s["items"]?.["type"] ?? "string") : s["additionalProperties"] ? "map" : s["$ref"] ? "object" : (s["type"] ?? "string"),
      // A command's schema is text or a list (oneOf): given as its program and arguments, after `--`.
      list: s["type"] === "array" || Array.isArray(s["oneOf"]),
      command: Array.isArray(s["oneOf"]),
      required: required.includes(name),
      doc: String(s["description"] ?? ""),
    }));
}

/** Every command a document names: each operation, then each shortcut. */
export function commandsOf(doc: Schema): Command[] {
  const out: Command[] = [];
  for (const methods of Object.values<Record<string, Schema>>(doc["paths"] ?? {})) {
    for (const op of Object.values(methods)) {
      const id = op["operationId"];
      if (typeof id !== "string" || !id.includes(".")) continue;
      const [product, verb] = id.split(".") as [string, string];
      const params: Schema[] = op["parameters"] ?? [];
      const content = op["requestBody"]?.["content"] ?? {};
      const body = resolve(doc, content["application/json"]?.["schema"]);
      const query = params.filter((p) => p["in"] === "query");
      const flags = [
        ...flagsOf(Object.fromEntries(query.map((p) => [p["name"], { ...p["schema"], description: p["description"] }])), query.filter((p) => p["required"]).map((p) => p["name"]), []),
        ...flagsOf(body["properties"] ?? {}, body["required"] ?? [], []),
      ];
      out.push({
        name: id,
        product,
        verb: kebab(verb),
        doc: String(op["summary"] ?? ""),
        args: params.filter((p) => p["in"] === "path").map((p) => p["name"]),
        flags,
        stdin: Boolean(content["application/octet-stream"]),
      });
    }
  }
  for (const s of (doc["x-shortcuts"] ?? []) as (Shortcut & { inputSchema: Schema })[]) {
    out.push({
      name: s.name,
      product: s.name,
      verb: "",
      doc: s.description,
      args: [],
      flags: flagsOf(s.inputSchema["properties"] ?? {}, s.inputSchema["required"] ?? [], []),
      stdin: false,
      shortcut: s,
    });
  }
  return out;
}

/** The copy of the document shipped in the package, beside this file. */
function shipped(): Schema {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "openapi.json"), join(here, "../../../../engines/front/crates/spec/openapi/v2.json")]) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      // the next place
    }
  }
  return {};
}

/** The API's document: the server's when it answers (a 304 keeps the copy
 * on disk), else the last one kept, else the shipped one. */
export async function document(baseUrl: string, fetcher: typeof fetch = fetch): Promise<{ doc: Schema; from: "server" | "cache" | "shipped" }> {
  const dir = process.env["RUNTIME_CACHE_DIR"] ?? join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "runtime");
  const file = join(dir, `openapi-${encodeURIComponent(new URL(baseUrl).host)}.json`);
  let kept: { etag?: string; doc: Schema } | undefined;
  try {
    kept = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    kept = undefined;
  }
  try {
    const res = await fetcher(`${baseUrl}/v2/openapi.json`, {
      headers: kept?.etag ? { "if-none-match": kept.etag } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 304 && kept) return { doc: kept.doc, from: "server" };
    if (res.ok) {
      const doc = (await res.json()) as Schema;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify({ etag: res.headers.get("etag") ?? undefined, doc }));
      } catch {
        // an unwritable cache: read again next time
      }
      return { doc, from: "server" };
    }
  } catch {
    // offline: the copy kept, or the shipped one
  }
  return kept ? { doc: kept.doc, from: "cache" } : { doc: shipped(), from: "shipped" };
}
