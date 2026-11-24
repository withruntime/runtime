/* The CLI's commands, read from the API's own description (GET
   /v2/openapi.json, which the server makes from the spec it serves), so a
   verb is a command the moment it is live, with no new release. The
   document is kept on disk with its ETag, checked in one round trip on each
   start, and the copy shipped in the package is used when neither answers. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Json, arr, num, obj, str, strs } from "./json.js";

/** One flag: a field of a verb's query or body, or a shortcut's argument. */
export interface Flag {
  flag: string;
  field: string;
  type: string;
  list: boolean;
  /** A command (text run by bash -lc, or a list run without a shell): what follows `--` on the command line. */
  command?: boolean;
  /** A secret (writeOnly): never a flag, where shell history and `ps` keep it; read from standard input or --from-file. */
  secret?: boolean;
  /** The values it takes, when its schema lists them. */
  choices?: string[];
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
  return name
    .replace(/MiB/g, "Mib")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/** A schema, followed through its `$ref` within `doc`. */
function resolve(doc: Json, v: unknown): Json {
  const s = obj(v);
  const ref = str(s["$ref"]);
  return ref === undefined
    ? s
    : ref
        .replace(/^#\//, "")
        .split("/")
        .reduce((o, k) => obj(o[k]), doc);
}

function flagsOf(props: Json, required: string[], skip: string[]): Flag[] {
  return Object.entries(props)
    .filter(([name]) => !skip.includes(name))
    .map(([name, v]) => {
      const s = obj(v);
      const one = s["type"] === "array" ? obj(s["items"]) : s;
      return {
        flag: kebab(name),
        field: name,
        // Its one value's type, a list's item's: each flag's value is typed by it (cli.ts `value`).
        type: one["additionalProperties"]
          ? "map"
          : one["$ref"]
            ? "object"
            : (str(one["type"]) ?? "string"),
        // A command's schema is text or a list (oneOf): given as its program and arguments, after `--`.
        list: s["type"] === "array" || Array.isArray(s["oneOf"]),
        command: Array.isArray(s["oneOf"]),
        secret: s["writeOnly"] === true,
        ...(Array.isArray(one["enum"])
          ? { choices: arr(one["enum"]).map((c) => String(c as string | number | boolean)) }
          : {}),
        required: required.includes(name),
        doc: str(s["description"]) ?? "",
      };
    });
}

/** Every command a document names: each operation, then each shortcut. */
export function commandsOf(doc: Json): Command[] {
  const out: Command[] = [];
  for (const methods of Object.values(obj(doc["paths"]))) {
    for (const v of Object.values(obj(methods))) {
      const op = obj(v);
      const id = str(op["operationId"]);
      if (id === undefined || !id.includes(".")) continue;
      const [product = "", verb = ""] = id.split(".");
      const params = arr(op["parameters"]).map(obj);
      const content = obj(obj(op["requestBody"])["content"]);
      const body = resolve(doc, obj(content["application/json"])["schema"]);
      const named = (p: Json) => str(p["name"]) ?? "";
      const query = params.filter((p) => p["in"] === "query");
      const flags = [
        ...flagsOf(
          Object.fromEntries(
            query.map((p) => [named(p), { ...obj(p["schema"]), description: p["description"] }]),
          ),
          query.filter((p) => p["required"] === true).map(named),
          [],
        ),
        ...flagsOf(obj(body["properties"]), strs(body["required"]), []),
      ];
      out.push({
        name: id,
        product,
        verb: kebab(verb),
        doc: str(op["summary"]) ?? "",
        args: params.filter((p) => p["in"] === "path").map(named),
        flags,
        stdin: "application/octet-stream" in content,
      });
    }
  }
  for (const v of arr(doc["x-shortcuts"])) {
    const s = shortcutOf(obj(v));
    if (!s) continue;
    const input = obj(obj(v)["inputSchema"]);
    out.push({
      name: s.name,
      product: s.name,
      verb: "",
      doc: s.description,
      args: [],
      flags: flagsOf(obj(input["properties"]), strs(input["required"]), []),
      stdin: false,
      shortcut: s,
    });
  }
  return out;
}

/** A shortcut as the document names it, or undefined when it is not one. */
function shortcutOf(s: Json): Shortcut | undefined {
  const name = str(s["name"]);
  const answer = num(s["answer"]);
  if (name === undefined || answer === undefined) return undefined;
  const steps: Step[] = [];
  for (const t of arr(s["steps"]).map(obj)) {
    const verb = str(t["verb"]);
    if (verb === undefined) return undefined;
    const args: Step["args"] = {};
    for (const [k, a] of Object.entries(obj(t["args"]))) {
      const from = obj(a);
      const arg = str(from["arg"]);
      const step = num(from["step"]);
      const field = str(from["field"]);
      if (arg !== undefined) args[k] = { arg };
      else if (step !== undefined && field !== undefined) args[k] = { step, field };
      else return undefined;
    }
    steps.push({ verb, args, always: t["always"] === true });
  }
  return { name, description: str(s["description"]) ?? "", steps, answer };
}

/** The copy of the document shipped in the package, beside this file. */
function shipped(): Json {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [
    join(here, "openapi.json"),
    join(here, "../../../../engines/front/crates/spec/openapi/v2.json"),
  ]) {
    try {
      return obj(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      // the next place
    }
  }
  return {};
}

/** The API's document: the server's when it answers (a 304 keeps the copy
 * on disk), else the last one kept, else the shipped one. */
export async function document(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{ doc: Json; from: "server" | "cache" | "shipped" }> {
  const dir =
    process.env["RUNTIME_CACHE_DIR"] ??
    join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "runtime");
  const file = join(dir, `openapi-${encodeURIComponent(new URL(baseUrl).host)}.json`);
  let kept: { etag?: string; doc: Json } | undefined;
  try {
    const k = obj(JSON.parse(readFileSync(file, "utf8")));
    kept = { etag: str(k["etag"]), doc: obj(k["doc"]) };
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
      const doc = obj(await res.json());
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
