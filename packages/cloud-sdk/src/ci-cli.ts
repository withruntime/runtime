import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CiSource, importCi } from "./ci-import.js";
import { me, named } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import {
  ci,
  type CiCheck,
  type CiCheckState,
  type CiFlake,
  type CiFlakeState,
  type CiJob,
  type CiAnnotation,
  type CiReview,
  type CiRepository,
  type ConnectCiRepository,
} from "./products/ci.js";

/* `runtime ci`, kept out of cli.ts as apps-cli.ts is: CI/CD's repositories,
   checks, jobs, test files and flaky tests. In a private beta: a key outside it is
   refused product_in_beta, said in the server's words and hint
   (cli-words.ts), never as a stack. Any key an owner or admin made lists
   the account's repositories; a full one of theirs connects, trusts and
   disconnects. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };

export const CI_HELP = `runtime ci <command>

  CI/CD checks each push and pull request of a connected GitHub repository in
  sandboxes, as the steps its config file names. A fork's pull request runs
  nothing; a writer can open it again from a branch of the repository. In a
  private beta: outside it, each command says how to ask to join.

  import [dir] [--write] [--force]            This folder's GitHub Actions workflows and CircleCI
                                              config as a runtime.yml: printed, or written with
                                              --write; what isn't carried over is noted at its top.
                                              Needs no key and sends nothing
  connect <owner/name> [--branch main] [--config runtime.yml] [--installation <id>]
          [--trust <app-slug>[bot]]... [--name <name>]
                                              Connect a repository; prints its id. Takes a full key.
                                              --config cloudbuild.yaml or buildspec.yml runs a Google
                                              Cloud Build or AWS CodeBuild config as it is.
                                              --trust runs that App's pushes as its own from the start
  repos [ls] [--all]                          Connected repositories, with the Apps each trusts;
                                              --all: disconnected ones too
  repos trust <repoId | owner/name> <app-slug>[bot]...
                                              Run that App's pushes as the repository's own code,
                                              keeping the Apps it trusts already
  repos untrust <repoId | owner/name> <app-slug>[bot]...
                                              Stop trusting those Apps, keeping the rest
  repos undo <repoId | owner/name> on|off     When main's check fails, find the first commit that
                                              fails it and open a pull request reverting it, which
                                              lands once its check passes. Off until turned on;
                                              takes an owner's or admin's full key
  disconnect <repoId | owner/name>            Stop checking it; its checks still going are cancelled
  checks [--repository <repoId>] [--branch <name>] [--commit <sha>] [--pr <number>]
     [--state <state>]... [--limit 20]        Checks, newest first, with their jobs by state (or ls)
  check <checkId>                             One check and its jobs in plan order (or get)
  cancel <checkId>                            Cancel a queued or running check: its jobs end,
                                              its machines are let go, GitHub is told
  rerun <checkId>                             Run a check again: a new check of its commit, a
                                              pull request's as it would land now
  logs <jobId>                                A job's output, its last 256 KiB, and its sandboxes
  tests <repoId> [--quarantined]              Its test files: time, recent outcomes, quarantine
  flakes [--repository <repoId>] [--all]      Flaky tests: each quarantined (or still gating), its
                                              owner and 48-hour deadline; --all: ended ones too
  flake <flakeId>                             One flaky test: its proof, owner, and recent runs
  flake prove <flakeId>                       Its 100 proof runs again at main's next commit
  flake hand <flakeId> <login | org/team>     Hand it to someone else
  flake delete <flakeId> --reason <why>       Say why its test is deleted; it ends once main
                                              no longer holds the file
  releases [--repository <repoId>] [--commit <sha>] [--limit 50]
                                              A release's steps as they were taken, oldest
                                              first: migrations, deploys, servers, waits

  A failed job's sandbox may be kept paused: \`runtime sandboxes wake <id>\`, then
  \`runtime sandboxes shell <id>\` to look around where it failed. A key reads the
  checks of repositories its own agent connected; an account-wide key reads and
  cancels every check of the account (switch one at withruntime.com/account/keys).

Examples
  runtime ci import --write
  runtime ci connect acme/web --config .runtime/ci.yml
  runtime ci repos trust acme/web acme-bot[bot]
  runtime ci repos undo acme/web on
  runtime ci checks --commit $(git rev-parse HEAD)
  runtime ci cancel <checkId>
  runtime ci logs <jobId>
`;

const when = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString());
const took = (from: number | null, to: number | null) =>
  from === null || to === null ? "-" : `${((to - from) / 1000).toFixed(1)}s`;
const counted = (c: CiCheck["counts"]) =>
  Object.entries(c)
    .map(([state, n]) => `${n} ${state}`)
    .join(", ") || "-";
/** Where a check's machines came from and how soon, in a line. */
const machined = (m: CiCheck["machines"]) => {
  if (!m) return null;
  const from = [
    m.reused && `${m.reused} its pull request's own`,
    m.pooled && `${m.pooled} pooled`,
    m.forked && `${m.forked} forked in ${m.forks}`,
    m.created && `${m.created} created`,
  ].filter(Boolean);
  const s = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(2)}s`);
  return `machines: ${from.join(", ") || "none"}; first in ${s(m.firstMs)}, first test at ${s(m.firstTestMs)}${m.lineMs ? `, ${s(m.lineMs)} in line` : ""}${m.kept ? `; ${m.kept} kept for the next push` : ""}`;
};
const where = (c: CiCheck) =>
  c.pullRequest !== null ? `#${c.pullRequest}` : (c.branch ?? c.event);
const STATES = ["queued", "running", "passed", "failed", "cancelled"];
const ownerOf = (f: CiFlake) =>
  f.owner === null
    ? "nobody found"
    : `@${f.owner.login}${f.owner.pullRequest === null ? "" : ` (#${f.owner.pullRequest})`}`;

/** `runtime ci import [dir] [--write] [--force]`: the folder's GitHub Actions
 * workflows and CircleCI config as a `runtime.yml`, printed or written. */
async function importCommand(argv: string[], out: Out, kit: CliKit): Promise<number> {
  const args = kit.parse(argv, ["write", "force"], []);
  const root = args.positional[0] ?? ".";
  const files: CiSource[] = [];
  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows))
    for (const name of readdirSync(workflows).sort())
      if (/\.ya?ml$/.test(name))
        files.push({
          path: `.github/workflows/${name}`,
          text: readFileSync(join(workflows, name), "utf8"),
        });
  const circle = join(root, ".circleci", "config.yml");
  if (existsSync(circle))
    files.push({ path: ".circleci/config.yml", text: readFileSync(circle, "utf8") });
  if (!files.length) {
    // Cloud Build and CodeBuild configs run as they are: nothing to import.
    const vendor = ["cloudbuild.yaml", "cloudbuild.yml", "buildspec.yml", "buildspec.yaml"].find(
      (name) => existsSync(join(root, name)),
    );
    if (vendor)
      throw kit.usage(
        `${vendor} needs no import: CI/CD runs it as it is. Connect with ${me} ci connect <owner/name> --config ${vendor}, or add "- ${vendor.startsWith("cloudbuild") ? "cloudbuild" : "buildspec"}: ${vendor}" to runtime.yml's steps.`,
      );
    throw kit.usage(
      `${root} has neither .github/workflows/*.yml nor .circleci/config.yml to import.`,
    );
  }
  const made = importCi(files);
  if (!made.yaml) {
    out.error(made.notes.join("\n"));
    throw kit.usage("No job of these runs on a push or a pull request: nothing to write.");
  }
  if (!kit.has(args, "write")) {
    out.write(
      out.json ? JSON.stringify({ ...made, read: files.map((f) => f.path) }) : made.yaml.trimEnd(),
    );
    return 0;
  }
  const target = join(root, "runtime.yml");
  if (existsSync(target) && !kit.has(args, "force"))
    throw kit.usage(`${target} is there already: --force writes over it.`);
  writeFileSync(target, made.yaml);
  const notes = made.notes.length
    ? `, ${made.notes.length} notes on what was not carried over at its top`
    : "";
  out.write(
    out.json
      ? JSON.stringify({ ...made, read: files.map((f) => f.path), written: target })
      : `${target}: ${made.steps.length} steps from ${files.length === 1 ? "1 file" : `${files.length} files`}${notes}. Push it, then \`${me} ci connect <owner/name>\`.`,
  );
  return 0;
}

export async function ciCommand(
  argv: string[],
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has, need, table, usage, unknown } = kit;
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(CI_HELP), { usage: named(CI_HELP) });
    return 0;
  }
  // Reads and writes this folder's files only: no key, nothing sent.
  if (verb === "import") return importCommand(rest, out, kit);
  const api = ci((await client()).transport);
  const whole = (value: string | undefined, what: string) => {
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]{0,8}$/.test(value)) throw usage(`${what} takes a whole number: ${value}`);
    return Number(value);
  };
  const apps = (words: string[]) => {
    if (!words.length) throw usage(`Name an App by its login, such as acme-bot[bot].`);
    for (const word of words)
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$/.test(word))
        throw usage(
          `${word} is not an App's login: name it <app-slug>[bot], as GitHub shows its pushes (quote it in your shell: '${word.replace(/\[bot\]$/, "")}[bot]').`,
        );
    return words;
  };
  const trusted = (r: CiRepository) => r.trustedApps?.join(", ") || "none";
  const disconnect = async (idOrName: string) => {
    const found = await api.repositories.find(idOrName);
    const repo = await api.repositories.disconnect(found?.id ?? idOrName);
    print(`${repo.repository} disconnected; its checks that ended stay.`, repo);
    return 0;
  };
  switch (verb) {
    case "connect": {
      const args = parse(rest, [], ["branch", "config", "installation", "trust", "name"]);
      const repository = need(args.positional[0], "the repository, such as acme/web");
      const installation = whole(flag(args, "installation"), "--installation");
      const trust = args.flags.get("trust") ?? [];
      const input: ConnectCiRepository = {
        repository,
        ...(flag(args, "branch") ? { productionBranch: flag(args, "branch")! } : {}),
        ...(flag(args, "config") ? { configPath: flag(args, "config")! } : {}),
        ...(installation === undefined ? {} : { installation }),
        ...(trust.length ? { trustedApps: apps(trust) } : {}),
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
      };
      const repo = await api.repositories.connect(input);
      if (!out.json)
        out.error(
          `Connected ${repo.repository}: each push and pull request is checked as ${repo.configPath} says; ${repo.productionBranch} is its production branch; it trusts ${trusted(repo)}. Its checks: ${me} ci ls --repository ${repo.id}`,
        );
      print(repo.id, repo);
      return 0;
    }
    case "repos":
    case "repositories": {
      const [action, ...more] = rest;
      if (action === "trust" || action === "untrust") {
        const [which, ...logins] = more;
        const id = need(which, "the repository's id or owner/name");
        const listed = apps(logins);
        const repo =
          action === "trust"
            ? await api.repositories.trust(id, listed)
            : await api.repositories.untrust(id, listed);
        print(`${repo.repository} trusts ${trusted(repo)}.`, repo);
        return 0;
      }
      if (action === "undo") {
        const id = need(more[0], "the repository's id or owner/name");
        const say = need(more[1], "on or off");
        if (say !== "on" && say !== "off")
          throw usage(`${say} is neither on nor off: ${me} ci repos undo ${id} on`);
        const found = await api.repositories.find(id);
        const repo = await api.repositories.setUndo(found?.id ?? id, say === "on");
        print(
          repo.undoCulprits
            ? `${repo.repository}: when ${repo.productionBranch}'s check fails, its culprit is found and a pull request reverting it opens.`
            : `${repo.repository}: a failing ${repo.productionBranch} is reported, never undone.`,
          repo,
        );
        return 0;
      }
      if (action === "connect") return ciCommand(["connect", ...more], out, client, kit);
      if (action === "disconnect" || action === "rm")
        return disconnect(need(more[0], "the repository's id or owner/name"));
      const listing = action === "ls" || action === "list" ? more : rest;
      if (listing.length && !listing[0]!.startsWith("-"))
        throw unknown("ci repos command", listing[0]!, [
          "ls",
          "connect",
          "trust",
          "untrust",
          "undo",
          "disconnect",
        ]);
      const args = parse(listing, ["all"], []);
      const all = await (
        await api.repositories.list({
          limit: 100,
          ...(has(args, "all") ? {} : { state: ["connected"] as CiRepository["state"][] }),
        })
      ).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "REPOSITORY", "BRANCH", "CONFIG", "TRUSTED APPS", "UNDO", "STATE"],
              ...all.map((r) => [
                r.id,
                r.repository,
                r.productionBranch,
                r.configPath,
                trusted(r),
                r.undoCulprits ? "on" : "off",
                r.state,
              ]),
            ])
          : `No repositories this key lists. Connect one: ${me} ci connect acme/web`,
        all,
      );
      return 0;
    }
    case "disconnect":
      return disconnect(need(rest[0], "the repository's id or owner/name"));
    case "ls":
    case "list":
    case "checks": {
      const args = parse(rest, [], ["repository", "branch", "commit", "pr", "state", "limit"]);
      const commit = flag(args, "commit");
      if (commit !== undefined && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
        throw usage(
          `--commit takes a full sha in lower case: ${me} ci ls --commit $(git rev-parse HEAD)`,
        );
      const states = args.flags.get("state");
      for (const state of states ?? [])
        if (!STATES.includes(state)) throw unknown("state", state, STATES);
      const pullRequest = whole(flag(args, "pr"), "--pr");
      const limit = whole(flag(args, "limit"), "--limit") ?? 20;
      const page = await api.checks.list({
        limit: Math.min(limit, 100),
        ...(flag(args, "repository") ? { repositoryId: flag(args, "repository")! } : {}),
        ...(flag(args, "branch") ? { branch: flag(args, "branch")! } : {}),
        ...(commit ? { commit } : {}),
        ...(pullRequest === undefined ? {} : { pullRequest }),
        ...(states ? { state: states as CiCheckState[] } : {}),
      });
      const all = await page.toArray(limit);
      print(
        all.length
          ? table([
              ["ID", "STATE", "REPOSITORY", "WHERE", "COMMIT", "JOBS", "TOOK", "CREATED"],
              ...all.map((c) => [
                c.id,
                c.waiting ? "waiting" : c.state,
                c.repository,
                where(c),
                c.commit.slice(0, 12),
                counted(c.counts),
                took(c.startedAt, c.endedAt),
                when(c.createdAt),
              ]),
            ])
          : "No checks.",
        all,
      );
      return 0;
    }
    case "get":
    case "check": {
      const check = await api.checks.get(need(rest[0], "a check's id"));
      const job = (j: CiJob) => [
        j.id,
        j.parts > 1 ? `${j.name} (${j.part}/${j.parts})` : j.name,
        j.state,
        j.ms === null ? "-" : `${(j.ms / 1000).toFixed(1)}s`,
        j.exitCode === null ? "-" : String(j.exitCode),
        j.sandboxIds.join(",") || "-",
      ];
      print(
        [
          `${check.repository} ${check.commit.slice(0, 12)} ${where(check)}: ${check.waiting ? "waiting for a writer to re-run it on GitHub" : check.state}${check.reason ? ` (${check.reason})` : ""}`,
          ...(check.machines ? [machined(check.machines)!] : []),
          check.jobs.length
            ? table([["JOB", "NAME", "STATE", "TOOK", "EXIT", "SANDBOXES"], ...check.jobs.map(job)])
            : "No jobs yet.",
        ].join("\n"),
        check,
      );
      return 0;
    }
    case "cancel": {
      const check = await api.checks.cancel(need(rest[0], "a check's id (runtime ci ls)"));
      // A key that may cancel the check but not read it is told its state alone.
      if (!("commit" in check)) {
        print(`${check.id}: ${check.state}`, check);
        return 0;
      }
      print(
        `${check.repository} ${check.commit.slice(0, 12)} ${where(check)}: ${check.state}${check.reason ? ` (${check.reason})` : ""}`,
        check,
      );
      return 0;
    }
    case "rerun": {
      const check = await api.checks.rerun(need(rest[0], "a check's id (runtime ci ls)"));
      // A key that may run the check again but not read it is told the new one's id alone.
      if (!("commit" in check)) {
        print(`${check.id}: ${check.state}`, check);
        return 0;
      }
      print(
        `${check.id} ${check.repository} ${check.commit.slice(0, 12)} ${where(check)}: ${check.state}${check.reason ? ` (${check.reason})` : ""}`,
        check,
      );
      return 0;
    }
    case "logs":
    case "job": {
      const job = await api.jobs.get(need(rest[0], "a job's id (runtime ci get <checkId>)"));
      if (out.json) {
        out.write(JSON.stringify(job));
        return 0;
      }
      out.write(job.log.endsWith("\n") || !job.log ? job.log : `${job.log}\n`);
      if (job.review) out.write(reviewed(job.review));
      // An API before annotations sends none.
      if (job.annotations?.length) out.write(annotated(job.annotations));
      out.error(
        `[${job.name}${job.parts > 1 ? ` ${job.part}/${job.parts}` : ""} ${job.state}${job.exitCode === null ? "" : `, exit code ${job.exitCode}`}${job.reason ? `, ${job.reason}` : ""}]`,
      );
      if (job.state === "failed" && job.sandboxIds.length)
        out.error(
          `Its sandbox may be kept paused, to look into: ${me} sandboxes wake ${job.sandboxIds[0]}, then ${me} sandboxes shell ${job.sandboxIds[0]}`,
        );
      return 0;
    }
    case "flakes": {
      const args = parse(rest, ["all"], ["repository"]);
      const repositoryId = flag(args, "repository");
      const all = await (
        await api.flakes.list({
          limit: 100,
          ...(repositoryId ? { repositoryId } : {}),
          ...(has(args, "all") ? {} : { state: ["quarantined", "gating"] as CiFlakeState[] }),
        })
      ).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "FILE", "STATE", "OWNER", "DUE"],
              ...all.map((f) => [
                f.id,
                f.file,
                f.state,
                ownerOf(f),
                f.endedAt !== null ? "-" : `${when(f.dueAt)}${f.overdue ? " (overdue)" : ""}`,
              ]),
            ])
          : "No flaky tests.",
        all,
      );
      return 0;
    }
    case "flake": {
      const [sub, ...more] = rest;
      if (sub === "prove" || sub === "hand" || sub === "delete") {
        const args = parse(more, [], ["reason"]);
        const id = need(args.positional[0], "a flake's id (runtime ci flakes)");
        const change =
          sub === "prove"
            ? { prove: true as const }
            : sub === "hand"
              ? { owner: need(args.positional[1], "a GitHub login, or org/team") }
              : { deleteReason: need(flag(args, "reason"), "--reason <why its test is deleted>") };
        const f = await api.flakes.update(id, change);
        print(
          sub === "prove"
            ? `${f.file}: its 100 proof runs come at main's next commit.\n`
            : sub === "hand"
              ? `${f.file}: handed to ${ownerOf(f)}.\n`
              : `${f.file}: it ends once main no longer holds the file.\n`,
          f,
        );
        return 0;
      }
      const f = await api.flakes.get(need(sub, "a flake's id (runtime ci flakes)"));
      const runs = f.runs
        .slice(0, 20)
        .map((r) => `${r.passed ? "pass" : "FAIL"} ${r.attempt}`)
        .join(", ");
      print(
        [
          `${f.file}: ${f.state}${f.gates ? ` (still gates: ${f.gates.words})` : ""}`,
          `  owner   ${ownerOf(f)}, due ${when(f.dueAt)}${f.overdue ? " (overdue)" : ""}`,
          `  proof   passed and failed under key ${f.proof.key.slice(0, 12)} at ${f.proof.commit.slice(0, 9)}`,
          `  runs    ${runs || "-"}`,
          ...f.failures
            .slice(0, 5)
            .map(
              (x) =>
                `  failed  ${x.jobId} at ${x.commit.slice(0, 9)}: ${x.message ?? ""} (${me} ci logs ${x.jobId})`,
            ),
          ...(f.deleteReason ? [`  delete  ${f.deleteReason}`] : []),
          "",
        ].join("\n"),
        f,
      );
      return 0;
    }
    case "releases": {
      const args = parse(rest, [], ["repository", "commit", "limit"]);
      const repositoryId = flag(args, "repository");
      const commit = flag(args, "commit");
      const limit = flag(args, "limit");
      const steps = (
        await api.releases.list({
          limit: limit ? whole(limit, "--limit") : 50,
          ...(repositoryId ? { repositoryId } : {}),
          ...(commit ? { commit } : {}),
        })
      ).data.reverse();
      print(
        steps.length
          ? table([
              ["AT", "RELEASE", "BY", "SERVER", "STEP"],
              ...steps.map((s) => [
                when(s.at),
                s.commit.slice(0, 9),
                s.source,
                s.host ?? "-",
                s.line,
              ]),
            ])
          : "No release steps.",
        steps,
      );
      return 0;
    }
    case "tests": {
      const args = parse(rest, ["quarantined"], []);
      const repositoryId = need(args.positional[0], "a repository's id (runtime ci repos)");
      const all = await (
        await api.tests.list(repositoryId, {
          limit: 100,
          ...(has(args, "quarantined") ? { quarantined: true } : {}),
        })
      ).toArray(Infinity);
      print(
        all.length
          ? table([
              ["FILE", "TOOK", "RECENT", "QUARANTINED"],
              ...all.map((t) => [
                t.file,
                `${(t.ms / 1000).toFixed(1)}s`,
                t.runs
                  .slice(-5)
                  .map((r) => r.outcome)
                  .join(" "),
                t.quarantinedSince === null ? "-" : when(t.quarantinedSince),
              ]),
            ])
          : "No test files yet.",
        all,
      );
      return 0;
    }
  }
  throw unknown("ci command", verb, [
    "connect",
    "repos",
    "disconnect",
    "checks",
    "check",
    "ls",
    "get",
    "cancel",
    "rerun",
    "logs",
    "tests",
    "flakes",
    "flake",
    "releases",
  ]);
}

/** An agent step's verdict in words: each finding with its place and fix,
 * then the notes, then who judged. */
/** A job's annotations as `path:line:col: level: title: message`, each
 * message's first line, the way compilers print them. */
export function annotated(lines: CiAnnotation[]): string {
  const failing = lines.filter((a) => a.level === "failure").length;
  return [
    `\n${lines.length} line${lines.length === 1 ? "" : "s"} of the repository's files${failing ? `, ${failing} failing` : ""}:`,
    ...lines.map((a) => {
      const at = `${a.path}:${a.startLine}${a.startColumn ? `:${a.startColumn}` : ""}`;
      const first = a.message.split("\n")[0];
      return `  ${at}: ${a.level}: ${a.title ? `${a.title}: ` : ""}${first}`;
    }),
    "",
  ].join("\n");
}

function reviewed(r: CiReview): string {
  const at = (f: { file: string; line: number }) => (f.line > 0 ? `${f.file}:${f.line}` : f.file);
  return [
    `\n${r.verdict === "pass" ? "Passed review" : `Blocked: ${r.findings.length} finding(s)`}. ${r.summary}`,
    ...r.findings.map((f) => `  ${f.kind} at ${at(f)}: ${f.what}\n    Fix: ${f.fix}`),
    ...r.notes.map((n) => `  note at ${at(n)}: ${n.what}`),
    `Judged by agent ${r.agent}${r.model ? ` (${r.model})` : ""}${r.account ? ` on ${r.account}` : ""}${r.cut ? ", diff cut short" : ""}: session ${r.session}`,
    "",
  ].join("\n");
}
