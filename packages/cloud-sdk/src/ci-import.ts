import { parse, stringify } from "yaml";

/* `runtime ci import`: a repository's GitHub Actions workflows or CircleCI
   config, written as the `runtime.yml` CI/CD reads, so a team moves its
   checks in an afternoon. Each job becomes a step (each matrix cell one
   step), `needs` and `requires` keep their order, installs move to `setup`
   (run once, kept as the warm machine every check forks), cache keys become
   `cache:`, services start with Docker in the step. What has no equal here
   (a marketplace action, an orb, a secret, an upload) is never dropped
   silently: each is a note, and the file says it in a comment on top. */

export type CiSource = { path: string; text: string };
export type CiImport = {
  /** The `runtime.yml`, its notes on top as comments; `null` when no job runs on a push or pull request. */
  yaml: string | null;
  /** What was not carried over, or carried differently, one line each. */
  notes: string[];
  /** The steps written, by name. */
  steps: string[];
};

type Step = {
  name: string;
  run: string;
  needs: string[];
  env: Record<string, string>;
  machine?: string;
};

const MOST_STEPS = 64;
const MOST_CACHE = 32;

// A project's own install: run once in setup and kept in the warm machine,
// so a check runs only its tests.
const INSTALL =
  /^(npm (ci|install|i)|yarn( install)?|pnpm (install|i)|bun (install|i)|pip3? install|python3? -m pip install|poetry install|uv sync|pipenv install|go mod download|cargo fetch|bundle install|composer install|mix deps\.get)(?=\s|$)/;

// Actions whose work a Runtime machine already did: the commit is checked
// out, and Node, Bun, Python, git and a C compiler are on it.
const DONE = /^actions\/checkout@/;
const TOOLS =
  /^(actions\/setup-(node|python|go|java|dotnet)|oven-sh\/setup-bun|pnpm\/action-setup|dtolnay\/rust-toolchain|actions-rs\/toolchain|ruby\/setup-ruby|astral-sh\/setup-uv|denoland\/setup-deno)@/;
const CACHE = /^actions\/cache(\/restore|\/save)?@/;
const HAS = "a machine has Node, Bun, Python, git and a C compiler; install anything else in setup";

const stepName = (raw: string) =>
  raw
    .replace(/[^A-Za-z0-9 _.:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 63)
    .trim() || "job";
const envName = (k: string) =>
  /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && !k.startsWith("RUNTIME_");
const quoteSh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A value as one shell word: its literal text single-quoted, each variable
 * `expand` put in (`${RUNTIME_CI_COMMIT}` for `${{ github.sha }}`) in double
 * quotes, so the shell fills it in and nothing else in the value is read. */
const wordSh = (parts: Part[]) =>
  parts.map((p) => (typeof p === "string" ? quoteSh(p) : `"\${${p.v}}"`)).join("") || "''";
const asText = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : typeof v === "string"
      ? v
      : typeof v === "number" || typeof v === "boolean"
        ? `${v}`
        : JSON.stringify(v);
/** An action's name with its pinned ref left off: `actions/cache@<sha>` is `actions/cache`. */
const action = (uses: string) => uses.split("@")[0]!;

/** Every combination of a GitHub `strategy.matrix`, its `exclude` and `include` applied. */
export function matrixCells(matrix: Record<string, unknown> | undefined): Record<string, string>[] {
  if (!matrix || typeof matrix !== "object") return [{}];
  const keys = Object.keys(matrix).filter((k) => k !== "include" && k !== "exclude");
  let cells: Record<string, string>[] = keys.length ? [{}] : [];
  for (const key of keys) {
    const values = matrix[key];
    if (!Array.isArray(values)) continue;
    cells = cells.flatMap((c) => values.map((v) => ({ ...c, [key]: asText(v) })));
  }
  const fits = (cell: Record<string, string>, rule: Record<string, string>) =>
    Object.entries(rule).every(([k, v]) => cell[k] === v);
  const text = (rule: unknown) =>
    Object.fromEntries(
      Object.entries(rule && typeof rule === "object" ? rule : {}).map(([k, v]) => [k, asText(v)]),
    );
  for (const rule of (matrix.exclude as unknown[]) ?? [])
    cells = cells.filter((c) => !fits(c, text(rule)));
  for (const rule of (matrix.include as unknown[]) ?? []) {
    const add = text(rule);
    const base = Object.fromEntries(Object.entries(add).filter(([k]) => keys.includes(k)));
    const matched = Object.keys(base).length ? cells.filter((c) => fits(c, base)) : [];
    if (matched.length) for (const c of matched) Object.assign(c, add);
    else cells.push(add);
  }
  return cells.length ? cells : [{}];
}

/** Files a cache key hashes: GitHub's `hashFiles('a', 'b')` or CircleCI's `{{ checksum "a" }}`. */
export function cacheFiles(key: string): string[] {
  const out: string[] = [];
  for (const m of key.matchAll(/hashFiles\(([^)]*)\)/g))
    for (const f of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) out.push(f[1]!);
  for (const m of key.matchAll(/checksum\s+"([^"]+)"/g)) out.push(m[1]!);
  return out.filter((f) => !f.includes("{{") && !f.startsWith("/") && !f.startsWith("~"));
}

/** Whether a line installs the project's own dependencies and nothing else:
 * `npm ci` or `pip install -r requirements.txt`, never `npm install pino@9`,
 * which one matrix cell asks and another doesn't. */
export function installsOnly(line: string): boolean {
  const t = line.trim();
  const m = INSTALL.exec(t);
  if (!m || /[|;&<>$`]/.test(t)) return false;
  const words = t.slice(m[0].length).trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (["-r", "--requirement", "-e", "--editable", "-c"].includes(w)) i++;
    else if (!w.startsWith("-") && w !== ".") return false;
  }
  return true;
}

class Writer {
  steps: Step[] = [];
  setup: string[] = [];
  cache = new Set<string>();
  notes: string[] = [];
  note(where: string, what: string) {
    const line = `${where}: ${what}`.replace(/\s+/g, " ");
    if (!this.notes.includes(line)) this.notes.push(line);
  }
  /** A step's lines, its installs moved to setup when they run there as
   * they did in the step: `movable` (the step names no folder and no env of
   * its own) and no line before it changes folder. Setup runs at the
   * repository's root with no step's env, so `npm ci` under
   * `working-directory: web`, or after `cd web`, stays in its step. */
  lines(script: string, movable = true): string[] {
    const kept: string[] = [];
    let moved = !movable;
    for (const line of script.split("\n")) {
      if (/(^|[;&|(]\s*)(cd|pushd)\b/.test(line.trim())) moved = true;
      if (!moved && installsOnly(line)) {
        if (!this.setup.includes(line.trim())) this.setup.push(line.trim());
      } else kept.push(line.replace(/\s+$/, ""));
    }
    while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
    while (kept.length && !kept[0]!.trim()) kept.shift();
    return kept;
  }
  unique(name: string) {
    let n = stepName(name);
    for (let i = 2; this.steps.some((s) => s.name === n); i++) n = stepName(`${name} ${i}`);
    return n;
  }
}

/** A job's steps as one script. Each step of GitHub's or CircleCI's ran in a
 * shell of its own, so a `cd` or an `export` in one never reached the next:
 * with more than one, each is a subshell. Undefined when none runs anything. */
function script(blocks: string[][]): string | undefined {
  const runs = blocks.filter((b) => b.some((l) => l.trim() && !l.trim().startsWith("#")));
  if (!runs.length) return undefined;
  const lines = blocks.flatMap((b) =>
    runs.length > 1 && runs.includes(b) ? ["(", ...b.map((l) => `  ${l}`), ")"] : b,
  );
  return ["set -e", ...lines].join("\n");
}

/** `${{ ... }}` in a GitHub value: matrix cells, the commit and the branch
 * filled in; a secret, or anything else only GitHub knows, leaves the value
 * out (undefined), and `bad` is told what. */
function expand(
  value: string,
  cell: Record<string, string>,
  bad: (what: string) => void,
): string | undefined {
  const parts = expandParts(value, cell, bad);
  return parts?.map((p) => (typeof p === "string" ? p : `\${${p.v}}`)).join("");
}

/** Literal text, or a variable the shell fills in. */
type Part = string | { v: string };

/** `expand`'s value as its literal parts and the variables put in for
 * GitHub's values, for a value written as one shell word (`wordSh`). */
function expandParts(
  value: string,
  cell: Record<string, string>,
  bad: (what: string) => void,
): Part[] | undefined {
  let ok = true;
  const parts: Part[] = [];
  const text = (t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (typeof last === "string") parts[parts.length - 1] = last + t;
    else parts.push(t);
  };
  let at = 0;
  for (const m of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    text(value.slice(at, m.index));
    at = m.index + m[0].length;
    const expr = m[1]!.trim();
    const c = /^matrix\.([A-Za-z0-9_-]+)$/.exec(expr);
    const e = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
    if (c && cell[c[1]!] !== undefined) text(cell[c[1]!]!);
    else if (expr === "github.sha") parts.push({ v: "RUNTIME_CI_COMMIT" });
    else if (expr === "github.ref_name" || expr === "github.head_ref")
      parts.push({ v: "RUNTIME_CI_BRANCH" });
    else if (expr === "github.workspace") parts.push({ v: "PWD" });
    else if (e) parts.push({ v: e[1]! });
    else {
      const s = /^secrets\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
      bad(s ? `secret ${s[1]}` : m[0]);
      ok = false;
    }
  }
  text(value.slice(at));
  return ok ? parts : undefined;
}

type Y = Record<string, unknown>;
/** A YAML mapping, or an empty one for anything else. */
const obj = (v: unknown): Y => (v && typeof v === "object" && !Array.isArray(v) ? (v as Y) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A key that is one name or a list of them (`needs: a` or `needs: [a, b]`). */
const names = (v: unknown): string[] => (typeof v === "string" ? [v] : list(v).map(asText));

const runsOnPush = (on: unknown) => {
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(obj(on));
  return events.some((e) => e === "push" || e === "pull_request" || e === "pull_request_target");
};

function read(w: Writer, file: CiSource): Y | undefined {
  try {
    return obj(parse(file.text));
  } catch (error) {
    w.note(file.path, `not read: ${(error as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

function fromActions(w: Writer, file: CiSource) {
  const doc = read(w, file);
  if (!doc?.jobs) return;
  if (!runsOnPush(doc.on)) {
    w.note(file.path, "skipped: it runs on neither push nor pull_request");
    return;
  }
  const top = obj(doc.env);
  const named = new Map<string, string[]>();
  const made: { steps: Step[]; needs: string[] }[] = [];
  for (const [id, raw] of Object.entries(obj(doc.jobs))) {
    const job = obj(raw);
    const where = `${file.path} ${id}`;
    if (job.uses) {
      w.note(where, `skipped: a reusable workflow (${asText(job.uses)}); import that file instead`);
      continue;
    }
    const runsOn = asText(job["runs-on"]);
    if (job.if) w.note(where, `its if (${asText(job.if)}) is not carried: it runs on every check`);
    if (Number(job["timeout-minutes"]) > 30)
      w.note(where, `asks ${asText(job["timeout-minutes"])} minutes; a job here runs at most 30`);
    if (job["continue-on-error"])
      w.note(where, "continue-on-error is not carried: a failure fails the check");
    const dir = asText(obj(obj(job.defaults).run)["working-directory"]);
    const cells = matrixCells(obj(obj(job.strategy).matrix));
    const jobSteps = list(job.steps).map(obj);
    // What the kept commands read: a matrix key only a left-out setup
    // action read (a Node version, say) names no step.
    const reads = JSON.stringify([
      job.env,
      job.services,
      jobSteps.map((s) => [s.run, s.env, s["working-directory"]]),
    ]);
    const steps: Step[] = [];
    const bodies = new Set<string>();
    for (const cell of cells) {
      const os = expand(runsOn, cell, () => {}) ?? runsOn;
      if (/macos|windows/i.test(os)) {
        w.note(where, `${os} is left out: Runtime machines are Linux`);
        continue;
      }
      const bad = (what: string) =>
        w.note(where, `${what} is not carried; set it in the step's env or a Runtime secret`);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...top, ...obj(job.env) })) {
        const value = expand(asText(v), cell, bad);
        if (value !== undefined && envName(k)) env[k] = value;
      }
      const blocks: string[][] = [];
      for (const [name, raw] of Object.entries(obj(job.services))) {
        const svc = obj(raw);
        const image = expand(asText(typeof raw === "string" ? raw : svc.image), cell, bad);
        if (!image) continue;
        const flags = Object.entries(obj(svc.env)).map(
          ([k, v]) => `-e ${k}=${wordSh(expandParts(asText(v), cell, bad) ?? [])}`,
        );
        const ports = list(svc.ports).map(asText);
        const moved = ports.some((p) => {
          const [a, b] = p.split(":");
          return b !== undefined && a !== b;
        });
        const net = moved ? ports.map((p) => `-p ${p}`) : ["--network host"];
        blocks.push([
          ["docker run -d --name", stepName(name).replace(/ /g, "-"), ...net, ...flags, image].join(
            " ",
          ),
        ]);
        w.note(
          where,
          `service ${name} starts with Docker in the step; wait for it as its health check did`,
        );
      }
      for (const s of jobSteps) {
        const uses = asText(s.uses);
        if (uses) {
          if (DONE.test(uses)) continue;
          if (TOOLS.test(uses)) w.note(where, `${action(uses)} is not needed: ${HAS}`);
          else if (CACHE.test(uses))
            for (const f of cacheFiles(asText(obj(s.with).key))) w.cache.add(f);
          else {
            w.note(where, `action ${action(uses)} is not carried; run its commands in the step`);
            blocks.push([`# was: uses: ${action(uses)}`]);
          }
          continue;
        }
        if (!s.run) continue;
        const said = asText(s.name ?? s.run).split("\n")[0];
        if (s.if && /failure\(\)|cancelled\(\)/.test(asText(s.if))) {
          w.note(where, `step "${said}" ran only on failure; left out`);
          continue;
        }
        if (s.if) w.note(where, `step "${said}": its if (${asText(s.if)}) is not carried`);
        const run = expand(asText(s.run), cell, bad);
        if (run === undefined) {
          blocks.push([`# left out (it needs a secret or a GitHub value): ${said}`]);
          continue;
        }
        const exports: string[] = [];
        for (const [k, v] of Object.entries(obj(s.env))) {
          const value = expandParts(asText(v), cell, bad);
          if (value !== undefined && envName(k)) exports.push(`export ${k}=${wordSh(value)}`);
        }
        const wd = asText(s["working-directory"]) || dir;
        const lines = w.lines(run, !wd && !exports.length);
        if (!lines.length) continue;
        blocks.push([...(wd ? [`cd ${quoteSh(wd)}`] : []), ...exports, ...lines]);
      }
      const run = script(blocks);
      if (!run) {
        w.note(where, "has no command left to run here; not written");
        continue;
      }
      // Cells that differ only in what a left-out action read run the same
      // commands: one step runs them.
      const body = JSON.stringify([run, env]);
      if (bodies.has(body)) {
        w.note(
          where,
          "matrix cells that differ only in a tool's version run once, on the machine's own",
        );
        continue;
      }
      bodies.add(body);
      const label = Object.entries(cell)
        .filter(([k]) => reads.includes(`matrix.${k}`))
        .map(([, v]) => v)
        .join(" ");
      const title = asText(job.name || id).includes("${{") ? id : asText(job.name || id);
      steps.push({ name: w.unique(label ? `${title} ${label}` : title), run, needs: [], env });
    }
    made.push({ steps, needs: names(job.needs) });
    named.set(
      id,
      steps.map((s) => s.name),
    );
  }
  for (const m of made)
    for (const s of m.steps) {
      s.needs = m.needs.flatMap((n) => named.get(n) ?? []);
      w.steps.push(s);
    }
}

// CircleCI's resource classes by vCPUs: medium is 2, large 4, xlarge 8, 2xlarge 16.
const CIRCLE_MACHINES: Record<string, string> = {
  small: "2cpu",
  medium: "2cpu",
  large: "4cpu",
  xlarge: "8cpu",
  "2xlarge": "16cpu",
  "2xlarge+": "16cpu",
};
const KEPT_BY_CHECK = [
  "store_artifacts",
  "store_test_results",
  "persist_to_workspace",
  "attach_workspace",
];

function fromCircle(w: Writer, file: CiSource) {
  const doc = read(w, file);
  if (!doc) return;
  const jobs = obj(doc.jobs);
  const commands = obj(doc.commands);
  if (doc.orbs)
    w.note(
      file.path,
      `orbs (${Object.keys(obj(doc.orbs)).join(", ")}) are not carried; run their commands in the step`,
    );
  // The jobs each workflow runs, with what each requires; every job when no workflow says.
  const runs: { job: string; name: string; requires: string[] }[] = [];
  const workflows = Object.entries(obj(doc.workflows))
    .filter(([k, v]) => k !== "version" && obj(v).jobs)
    .map(([k, v]) => [k, obj(v)] as const);
  for (const [wf, flow] of workflows) {
    if (flow.triggers) {
      w.note(`${file.path} ${wf}`, "skipped: a scheduled workflow");
      continue;
    }
    for (const entry of list(flow.jobs)) {
      if (typeof entry === "string") runs.push({ job: entry, name: entry, requires: [] });
      else
        for (const [job, raw] of Object.entries(obj(entry))) {
          const opts = obj(raw);
          if (opts.type === "approval") {
            w.note(`${file.path} ${job}`, "an approval hold is not carried");
            continue;
          }
          if (opts.matrix)
            w.note(`${file.path} ${job}`, "its matrix is not carried; one step is written");
          runs.push({ job, name: asText(opts.name ?? job), requires: names(opts.requires) });
        }
    }
  }
  if (!workflows.length)
    for (const job of Object.keys(jobs)) runs.push({ job, name: job, requires: [] });
  const named = new Map<string, string>();
  const pending: { step: Step; requires: string[] }[] = [];
  for (const r of runs) {
    if (named.has(r.name)) continue;
    const where = `${file.path} ${r.job}`;
    if (!jobs[r.job]) {
      w.note(where, "is an orb's job; not carried");
      continue;
    }
    const job = obj(jobs[r.job]);
    if (job.macos || job.windows) {
      w.note(where, "skipped: Runtime machines are Linux");
      continue;
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(job.environment))) if (envName(k)) env[k] = asText(v);
    const blocks: string[][] = [];
    const docker = list(job.docker).map(obj);
    if (docker[0]?.image) w.note(where, `ran in ${asText(docker[0].image)}; here ${HAS}`);
    for (const svc of docker.slice(1)) {
      const image = asText(svc.image);
      const flags = Object.entries(obj(svc.environment)).map(
        ([k, v]) => `-e ${k}=${quoteSh(asText(v))}`,
      );
      const name = stepName(
        asText(svc.name) || (image.split(":")[0]!.split("/").pop() ?? ""),
      ).replace(/ /g, "-");
      blocks.push([["docker run -d --name", name, "--network host", ...flags, image].join(" ")]);
      w.note(
        where,
        `service ${image} starts with Docker in the step; wait for it before the tests`,
      );
    }
    const dir = asText(job.working_directory);
    const walk = (steps: unknown[], depth: number) => {
      for (const raw of steps) {
        const [kind, opts]: [string, unknown] =
          typeof raw === "string"
            ? [raw, undefined]
            : (Object.entries(obj(raw))[0] ?? ["", undefined]);
        // The checkout is made; Docker runs on the machine itself.
        if (kind === "checkout" || kind === "setup_remote_docker") continue;
        if (kind === "run") {
          const o = obj(opts);
          const cmd = asText(typeof opts === "string" ? opts : o.command);
          if (o.when === "on_fail") {
            w.note(
              where,
              `step "${asText(o.name ?? cmd.split("\n")[0])}" ran only on failure; left out`,
            );
            continue;
          }
          const exports = Object.entries(obj(o.environment))
            .filter(([k]) => envName(k))
            .map(([k, v]) => `export ${k}=${quoteSh(asText(v))}`);
          // A step's working_directory is under the job's, which is where
          // the checkout went: here, the repository's root.
          const wd = asText(o.working_directory);
          const cd = wd && !/^[~/$]/.test(wd) && wd !== "." ? [`cd ${quoteSh(wd)}`] : [];
          const lines = w.lines(cmd, !cd.length && !exports.length);
          if (!lines.length) continue;
          if (wd && !cd.length && wd !== "." && wd !== dir)
            w.note(
              where,
              `working_directory ${wd} is not carried; the step runs at the repository's root`,
            );
          blocks.push([...cd, ...exports, ...lines]);
        } else if (kind === "restore_cache" || kind === "save_cache") {
          const o = obj(opts);
          for (const key of [o.key, ...list(o.keys)])
            for (const f of cacheFiles(asText(key))) w.cache.add(f);
        } else if (commands[kind] && depth < 4) {
          if (opts) w.note(where, `command ${kind}'s parameters are not filled in`);
          walk(list(obj(commands[kind]).steps), depth + 1);
        } else if (KEPT_BY_CHECK.includes(kind)) {
          w.note(
            where,
            `${kind} is not carried: a check keeps each job's log, and a failed job's sandbox`,
          );
        } else if (kind) {
          w.note(
            where,
            `${kind} (an orb's or unknown step) is not carried; run its commands in the step`,
          );
          blocks.push([`# was: ${kind}`]);
        }
      }
    };
    walk(list(job.steps), 0);
    const run = script(blocks);
    if (!run) {
      w.note(where, "has no command left to run here; not written");
      continue;
    }
    const machine = CIRCLE_MACHINES[asText(job.resource_class).replace(/^.*\./, "")];
    const step: Step = {
      name: w.unique(r.name),
      run,
      needs: [],
      env,
      ...(machine && machine !== "4cpu" ? { machine } : {}),
    };
    named.set(r.name, step.name);
    pending.push({ step, requires: r.requires });
  }
  for (const p of pending) {
    p.step.needs = p.requires.map((n) => named.get(n)).filter((n): n is string => !!n);
    w.steps.push(p.step);
  }
}

/** `runtime.yml` from GitHub Actions workflows (`.github/workflows/*.yml`)
 * and a CircleCI config (`.circleci/config.yml`), each given with its path. */
export function importCi(files: CiSource[]): CiImport {
  const w = new Writer();
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    if (f.path.includes(".circleci/")) fromCircle(w, f);
    else fromActions(w, f);
  if (!w.steps.length) return { yaml: null, notes: w.notes, steps: [] };
  if (w.steps.length > MOST_STEPS) {
    w.note(
      "runtime.yml",
      `${w.steps.length} steps; a file holds ${MOST_STEPS}, the rest are left out`,
    );
    w.steps = w.steps.slice(0, MOST_STEPS);
  }
  const cache = [...w.cache].slice(0, MOST_CACHE);
  const doc: Record<string, unknown> = {};
  if (w.setup.length) doc.setup = w.setup.join("\n");
  if (cache.length) doc.cache = cache;
  doc.steps = w.steps.map((s) => ({
    name: s.name,
    run: s.run,
    ...(s.needs.length ? { needs: s.needs } : {}),
    ...(s.machine ? { machine: s.machine } : {}),
    ...(Object.keys(s.env).length ? { env: s.env } : {}),
  }));
  const head = [
    `# Written by \`runtime ci import\` from ${files.map((f) => f.path).join(", ")}.`,
    ...(w.notes.length
      ? ["# Not carried over, or carried differently:", ...w.notes.map((n) => `#  - ${n}`)]
      : []),
  ];
  return {
    yaml: `${head.join("\n")}\n${stringify(doc, { lineWidth: 0 })}`,
    notes: w.notes,
    steps: w.steps.map((s) => s.name),
  };
}
