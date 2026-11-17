/* What every drop-in shares: a Runtime from the rival's options or the environment,
   a shell command as an exec's cmd, and bytes and text both ways. Each shim maps
   its rival's API onto the generated core's verbs and nothing more. */

import { Runtime, type Process } from "../../generated/index.js";

export interface RuntimeOptions {
  /** Defaults to RUNTIME_API_KEY. */
  apiKey?: string;
  /** Defaults to RUNTIME_API_URL, then https://api.withruntime.com. */
  baseUrl?: string;
}

export function client(o: RuntimeOptions = {}): Runtime {
  return new Runtime({ ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}) });
}

/** A shell command run as the rivals run theirs: text in bash, a login shell (the API's own `cmd`), a list as argv. */
export function shell(cmd: string | string[]): string | string[] {
  return cmd;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytes(data: string | Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export const text = (b: Uint8Array): string => dec.decode(b);

export function base64(data: string | Uint8Array): string {
  const b = bytes(data);
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s);
}

/** A command run to its end: its process, with the output it wrote (empty when none). */
export type Ran = Process & { stdout: string; stderr: string };

/** A command's run: its cmd, directory, environment, input and time limit. */
export async function run(
  k: Runtime,
  id: string,
  cmd: string | string[],
  o: { cwd?: string; env?: Record<string, string>; stdin?: string | Uint8Array; timeoutMs?: number } = {},
): Promise<Ran> {
  const p = await k.sandboxes.exec(id, {
    cmd,
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.stdin !== undefined ? { stdin: base64(o.stdin) } : {}),
    ...(o.timeoutMs ? { timeoutSeconds: o.timeoutMs / 1000 } : {}),
  });
  return { ...p, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** The entries of a folder, by one `ls`-free listing every Linux has: name, type, size, time. */
export async function list(k: Runtime, id: string, path: string): Promise<{ name: string; path: string; type: "file" | "dir"; size: number; modifiedTime: Date }[]> {
  const r = await run(k, id, ["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\t%y\\t%s\\t%T@\\n"]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot list ${path}`);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name = "", y, size, t] = l.split("\t");
      return { name, path: `${path.replace(/\/$/, "")}/${name}`, type: y === "d" ? "dir" : "file", size: Number(size), modifiedTime: new Date(Number(t) * 1000) };
    });
}
