import { me, named } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import { RuntimeError } from "./errors.js";
import { logStream } from "./terminal.js";
import {
  apps,
  type AppDeploy,
  type AppSettings,
  type CreateApp,
  type DeployApp,
  type UpdateApp,
} from "./products/apps.js";
import {
  builds,
  type Build,
  type BuildState,
  type ChangeRepository,
  type ConnectRepository,
  type Repository,
} from "./products/builds.js";
import {
  containers,
  type Container,
  type ContainerState,
  type CreateContainer,
  type UpdateContainer,
} from "./products/containers.js";

/* `runtime apps`, `runtime builds` and `runtime containers`, kept out of
   cli.ts as cli-extras.ts is. All three are in a private beta: a key outside
   it is refused product_in_beta, said in the server's words and hint
   (cli-words.ts), never as a stack. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
type Args = ReturnType<CliKit["parse"]>;

export const APP_HELP = `runtime apps <command>

  An App serves your web server from an image or a build. Copies start when
  requests come and stop when they end, between --min-copies and --max-copies.
  In a private beta: outside it, each command says how to ask to join.

  create [<name>] --vcpu <1-16> --memory <128-65536> --max-copies <1-1000>
         [--min-copies 0] [--concurrency 100] [--spares 2] [--port 8080]
         [--health-path /healthz] [--label key=value]...
                                              Make an App, waiting for its first deploy; prints its id
  ls [--all]                                  Your Apps: state, live version, copies; --all, deleted too
  get <app>                                   One App, in full (an id or its name)
  update <app> [--name <name>] [--vcpu n] [--memory n] [--min-copies n] [--max-copies n]
         [--concurrency n] [--spares n] [--port n] [--health-path /path] [--label key=value]...
                                              Change its settings
  rm <app>                                    Delete it and stop its copies
  deploy <app> (--image <image> | --build <buildId>) [--env KEY=VALUE]... [--keep-env]
         [--port 8080] [--health-path /healthz] [--no-wait]
                                              A new version. Waits until it is live, or says why it
                                              failed; --no-wait prints the deploy's id at once.
                                              --image: an image of yours (id, name, name:tag);
                                              --build: a build that succeeded (runtime builds).
                                              --env KEY alone sends KEY's value from your environment.
                                              --keep-env keeps the last deploy's environment, sealed
  deploys <app> [<deployId>] [--wait]         Each version's deploy: state and address; with an id,
                                              that one (--wait: until it ends)
  versions <app>                              Its versions; the live and previous ones keep saved copies
  copies <app>                                Its copies now: version, region, state
  rollback <app> [--no-wait]                  Put the previous version live again

Examples
  runtime apps create web --vcpu 1 --memory 512 --max-copies 3
  runtime apps deploy web --image web:latest --env NODE_ENV=production
  runtime apps rollback web
`;

export const BUILD_HELP = `runtime builds <command>

  A build turns a commit of a connected repository into a saved server an App
  deploys. A push to the production branch builds and deploys by itself.
  In a private beta: outside it, each command says how to ask to join.

  repos connect <owner/name | https URL> --deploy <app name> [--branch main] [--no-previews]
        [--root <folder>] [--install <command>] [--build <command>] [--start <command>]
        [--port 8080] [--health-path /healthz] [--build-env KEY=VALUE]... [--name <name>]
                                              Connect a repository; prints its id. --deploy takes an
                                              App's name, or function:<name>. --start runs once the
                                              build is done, with PORT set: the server the App deploys
  repos ls                                    Connected repositories
  repos change <repoId> [the options of connect but the repository]
                                              Change its settings; its id and builds stay
  repos disconnect <repoId>                   Stop building it; its builds stay
  repos install                               A link to install Runtime's GitHub App, so a private
                                              repository builds
  create <repoId> [--ref main] [--branch <name>] [--name <name>]
                                              Build a branch, tag or commit now; prints the build's id
  run <repoId> [--ref main] [--branch <name>] [--name <name>] [--raw]
                                              The same, then follows its log; exits 0 once it succeeds
  ls [--repository <repoId>] [--commit <sha>] [--state <state>]...
                                              Builds, oldest first; --commit: a full sha
  get <buildId>                               One build: state, commit, step times, what it made
  cancel <buildId>                            Stop a build that has not ended
  logs <buildId> [--follow] [--raw]           Its last 200 lines, or every line as it comes until it
                                              ends; on a terminal control characters show as \\uXXXX
                                              unless --raw

Examples
  runtime builds repos connect acme/web --deploy web --start "npm start"
  runtime builds run <repoId> --ref main
  runtime builds ls --commit $(git rev-parse HEAD)
`;

export const CONTAINER_HELP = `runtime containers <command>

  A container runs one OCI image's process on its own microVM, billed at the
  sandbox rates. It never sleeps unless --sleep; on exit it restarts when it
  serves a port, else it stops (--on-exit sets either).
  In a private beta: outside it, each command says how to ask to join.

  create <image> --vcpu <1-16> --memory <128-65536> [--name <name>] [--label key=value]...
         [--env KEY[=VALUE]]... [--entrypoint <program>] [--workdir /app] [--user <user>]
         [--port <1-65535>] [--on-exit restart|stop] [--sleep] [-- <command...>]
                                              Run it; prints its id. The image's digest is pinned.
                                              --env KEY alone sends KEY's value from your environment.
                                              --entrypoint drops the image's command; after --, the
                                              command replaces the image's
  ls [--all] [--state <state>]... [--label key=value]...
                                              Your containers: all but deleting and deleted, unless
                                              --all or --state
  get <container>                             One container, in full (an id or its name): its
                                              environment's names, never their values
  update <container> [--name <name>] [--label key=value]...
                                              Rename it or replace its labels
  rm <container> [--wait]                     Delete it and stop its process; --wait: until deleted

Examples
  runtime containers create nginx:1.27 --vcpu 1 --memory 512 --name web
  runtime containers create python:3.12 --vcpu 1 --memory 1024 -- python3 -m http.server 8000
  runtime containers rm web --wait
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (ms: number | null | undefined) => (ms == null ? "-" : new Date(ms).toISOString());
const ENDED: readonly BuildState[] = ["succeeded", "failed", "cancelled", "superseded"];

/** An App's id from its id or its name: a name is looked up among the Apps
 * not deleted, and must be one App's alone. */
async function appIdOf(api: ReturnType<typeof apps>, target: string, kit: CliKit) {
  if (UUID.test(target)) return target;
  const found = (await api.list({ name: target, state: ["waiting", "live", "failed"] })).data;
  if (found.length === 1) return found[0]!.id;
  throw kit.usage(
    found.length
      ? `${found.length} Apps are named ${target}; give one's id (${me} apps ls).`
      : `No App is named ${target}. Your Apps: ${me} apps ls`,
  );
}

/** The flags an App's settings are given with, as the API names them. */
function settings(args: Args, kit: CliKit): Partial<AppSettings> {
  const { integer, flag } = kit;
  const number = (name: string, field: keyof AppSettings) =>
    integer(args, name) === undefined ? {} : { [field]: integer(args, name)! };
  return {
    ...number("vcpu", "vcpu"),
    ...number("memory", "memoryMiB"),
    ...number("min-copies", "minCopies"),
    ...number("max-copies", "maxCopies"),
    ...number("concurrency", "concurrency"),
    ...number("spares", "spares"),
    ...number("port", "port"),
    ...(flag(args, "health-path") === undefined ? {} : { healthPath: flag(args, "health-path")! }),
  };
}
const SETTINGS = [
  "vcpu",
  "memory",
  "min-copies",
  "max-copies",
  "concurrency",
  "spares",
  "port",
  "health-path",
  "label",
];

/** A deploy that ended badly, said with its own words, hint and last output. */
function deployFailure(deploy: AppDeploy): RuntimeError | undefined {
  if (!deploy.error) return undefined;
  const last = deploy.error.lastOutput?.trim();
  return new RuntimeError({
    code: deploy.error.code,
    status: 0,
    message: `Version ${deploy.version} did not go live: ${deploy.error.message}${
      last ? `\nIts last output:\n${last}` : ""
    }`,
    hint: deploy.error.hint,
    details: { deploy },
  });
}

export async function appsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has, need, pairs, envPairs, table, usage } = kit;
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(APP_HELP), { usage: named(APP_HELP) });
    return 0;
  }
  const api = apps((await client()).transport);
  const idOf = (target: string | undefined) =>
    appIdOf(api, need(target, "an App's id or name"), kit);
  switch (verb) {
    case "create": {
      const args = parse(rest, [], SETTINGS);
      if (args.positional.length > 1)
        throw usage(`Give one name: ${me} apps create web --vcpu 1 --memory 512 --max-copies 2`);
      const given = settings(args, kit);
      for (const [option, field] of [
        ["vcpu", "vcpu"],
        ["memory", "memoryMiB"],
        ["max-copies", "maxCopies"],
      ] as const)
        if (given[field] === undefined)
          throw usage(
            `Give --${option}: ${me} apps create ${args.positional[0] ?? "web"} --vcpu 1 --memory 512 --max-copies 2`,
          );
      const input: CreateApp = {
        ...(given as CreateApp),
        ...(args.positional[0] ? { name: args.positional[0] } : {}),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
      };
      const app = await api.create(input);
      if (!out.json)
        out.error(
          `Created ${app.name ?? app.id}, waiting for its first version. Deploy one: ${me} apps deploy ${app.name ?? app.id} --image <image>`,
        );
      print(app.id, app);
      return 0;
    }
    case "ls":
    case "list": {
      const args = parse(rest, ["all"], []);
      const all = await (
        await api.list({
          limit: 100,
          ...(has(args, "all")
            ? { state: ["waiting", "live", "failed", "deleting", "deleted"] as const }
            : {}),
        })
      ).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "NAME", "STATE", "LIVE", "COPIES", "SIZE", "CREATED"],
              ...all.map((a) => [
                a.id,
                a.name ?? "-",
                a.state,
                a.liveVersion === null ? "-" : `v${a.liveVersion}`,
                `${a.minCopies}-${a.maxCopies}`,
                `${a.vcpu} vCPU, ${a.memoryMiB} MiB`,
                when(a.createdAt),
              ]),
            ])
          : `No Apps. Make one: ${me} apps create web --vcpu 1 --memory 512 --max-copies 2`,
        all,
      );
      return 0;
    }
    case "get": {
      const app = await api.get(await idOf(rest[0]));
      print(JSON.stringify(app, null, 2), app);
      return 0;
    }
    case "update": {
      const args = parse(rest, [], [...SETTINGS, "name"]);
      const id = await idOf(args.positional[0]);
      const change: UpdateApp = {
        ...settings(args, kit),
        ...(flag(args, "name") === undefined ? {} : { name: flag(args, "name")! }),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
      };
      if (!Object.keys(change).length)
        throw usage(
          `Give a setting to change, such as ${me} apps update ${args.positional[0]} --max-copies 4`,
        );
      const app = await api.update(id, change);
      print(`${app.name ?? app.id} updated.`, app);
      return 0;
    }
    case "rm":
    case "delete": {
      const app = await api.delete(await idOf(rest[0]));
      print(`${app.name ?? app.id} ${app.state}.`, app);
      return 0;
    }
    case "deploy": {
      const args = parse(
        rest,
        ["keep-env", "no-wait"],
        ["image", "build", "env", "port", "health-path"],
      );
      const id = await idOf(args.positional[0]);
      const image = flag(args, "image");
      const build = flag(args, "build");
      if ((image === undefined) === (build === undefined))
        throw usage(
          `Give --image <image> to deploy an image of yours, or --build <buildId> for a build that succeeded.`,
        );
      const port = kit.integer(args, "port");
      const healthPath = flag(args, "health-path");
      const wait = !has(args, "no-wait");
      const input = {
        ...(image !== undefined ? { image } : { build: build! }),
        ...(args.flags.has("env") ? { env: envPairs(args, env) } : {}),
        ...(has(args, "keep-env") ? { keepEnv: true } : {}),
        ...(port === undefined ? {} : { port }),
        ...(healthPath === undefined ? {} : { healthPath }),
        wait,
      } as DeployApp;
      if (wait && !out.json) out.error(`Deploying ${args.positional[0]}...`);
      const deploy = await api.deploy(id, input, { timeoutMs: 15 * 60_000 });
      const failed = deployFailure(deploy);
      if (failed && !out.json) throw failed;
      print(
        deploy.state === "live"
          ? `Version ${deploy.version} is live at ${deploy.url}`
          : `Version ${deploy.version}: ${deploy.state}. Follow it: ${me} apps deploys ${args.positional[0]} ${deploy.id} --wait`,
        deploy,
      );
      return failed ? 1 : 0;
    }
    case "deploys": {
      const args = parse(rest, ["wait"], []);
      const id = await idOf(args.positional[0]);
      const deployId = args.positional[1];
      if (deployId) {
        const deploy = has(args, "wait")
          ? await api.waitDeploy(id, deployId, { timeoutMs: 15 * 60_000 })
          : await api.getDeploy(id, deployId);
        const failed = deployFailure(deploy);
        if (failed && !out.json) throw failed;
        print(JSON.stringify(deploy, null, 2), deploy);
        return failed ? 1 : 0;
      }
      // Newest first; a version's deploy is read once per line, so the list
      // stops at the last 20.
      const versions = (await api.versions(id)).sort((a, b) => b.version - a.version).slice(0, 20);
      const deploys = await Promise.all(versions.map((v) => api.getDeploy(id, v.deploy)));
      print(
        deploys.length
          ? table([
              ["VERSION", "DEPLOY", "STATE", "FROM", "ADDRESS"],
              ...deploys.map((d, i) => [
                `v${d.version}${versions[i]!.live ? " (live)" : versions[i]!.previous ? " (previous)" : ""}`,
                d.id,
                d.state,
                versions[i]!.build ? `build ${versions[i]!.build}` : "image",
                d.url,
              ]),
            ])
          : `No deploys yet. Deploy one: ${me} apps deploy ${args.positional[0]} --image <image>`,
        deploys,
      );
      return 0;
    }
    case "versions": {
      const id = await idOf(rest[0]);
      const versions = (await api.versions(id)).sort((a, b) => b.version - a.version);
      print(
        versions.length
          ? table([
              ["VERSION", "LIVE", "PREVIOUS", "SAVED", "DEPLOY", "BUILD"],
              ...versions.map((v) => [
                `v${v.version}`,
                v.live ? "yes" : "-",
                v.previous ? "yes" : "-",
                v.saved ? "yes" : "-",
                v.deploy,
                v.build ?? "-",
              ]),
            ])
          : "No versions yet.",
        versions,
      );
      return 0;
    }
    case "copies": {
      const id = await idOf(rest[0]);
      const copies = await api.copies(id);
      print(
        copies.length
          ? table([
              ["COPY", "VERSION", "REGION", "STATE", "SINCE"],
              ...copies.map((c) => [c.id, `v${c.version}`, c.region, c.state, when(c.since)]),
            ])
          : "No copies awake. A request starts one.",
        copies,
      );
      return 0;
    }
    case "rollback": {
      const args = parse(rest, ["no-wait"], []);
      const id = await idOf(args.positional[0]);
      const deploy = await api.rollback(id, {
        wait: !has(args, "no-wait"),
        timeoutMs: 15 * 60_000,
      });
      const failed = deployFailure(deploy);
      if (failed && !out.json) throw failed;
      print(
        deploy.state === "live"
          ? `Version ${deploy.version} is live again at ${deploy.url}`
          : `Rolling back to version ${deploy.version}: ${deploy.state}.`,
        deploy,
      );
      return failed ? 1 : 0;
    }
  }
  throw kit.unknown("apps command", verb, [
    "create",
    "ls",
    "get",
    "update",
    "rm",
    "deploy",
    "deploys",
    "versions",
    "copies",
    "rollback",
  ]);
}

/** A repository as connect takes it: GitHub's owner/name, a github.com
 * address read as that, or any other https address as plain git. */
function source(repository: string): Pick<ConnectRepository, "provider" | "repository"> {
  const github = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repository);
  return github ? { provider: "github", repository: github[1]! } : { provider: "git", repository };
}
/** connect's and change's settings. */
function repositorySettings(args: Args, kit: CliKit): ChangeRepository {
  const { flag, has, integer, pairs } = kit;
  const text = (name: string, field: keyof ChangeRepository) =>
    flag(args, name) === undefined ? {} : { [field]: flag(args, name)! };
  const deploy = flag(args, "deploy");
  return {
    ...(deploy === undefined
      ? {}
      : {
          deploy: (/^(app|function|container):/.test(deploy)
            ? deploy
            : `app:${deploy}`) as ConnectRepository["deploy"],
        }),
    ...text("branch", "productionBranch"),
    ...(has(args, "no-previews") ? { previews: false } : {}),
    ...text("root", "rootDirectory"),
    ...text("install", "installCommand"),
    ...text("build", "buildCommand"),
    ...text("start", "startCommand"),
    ...(integer(args, "port") === undefined ? {} : { port: integer(args, "port")! }),
    ...text("health-path", "healthPath"),
    ...(args.flags.has("build-env") ? { buildEnv: pairs(args, "build-env") } : {}),
    ...text("name", "name"),
  };
}
const REPOSITORY_VALUES = [
  "deploy",
  "branch",
  "root",
  "install",
  "build",
  "start",
  "port",
  "health-path",
  "build-env",
  "name",
];

export async function buildsCommand(
  argv: string[],
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has, need, table, usage } = kit;
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(BUILD_HELP), { usage: named(BUILD_HELP) });
    return 0;
  }
  const api = builds((await client()).transport);
  const buildRow = (b: Build) => [
    b.id,
    b.state,
    b.ref,
    b.commit ? b.commit.slice(0, 12) : "-",
    when(b.createdAt),
    b.reason ?? "-",
  ];
  /** A build's log, its last lines or followed to its end. */
  const logs = async (id: string, follow: boolean, raw: boolean) => {
    const [stdout, stderr] = [logStream(process.stdout, raw), logStream(process.stderr, raw)];
    const write = (line: { stream: "stdout" | "stderr"; text: string }) =>
      (line.stream === "stderr" ? stderr : stdout)(
        line.text.endsWith("\n") ? line.text : `${line.text}\n`,
      );
    if (!follow) {
      const log = await api.logs(id);
      if (out.json) {
        out.write(JSON.stringify(log));
        return 0;
      }
      log.lines.forEach(write);
      if (log.failingStep)
        out.error(
          `[${log.state} at ${log.failingStep.name}${log.failingStep.exitCode === null ? "" : `, exit code ${log.failingStep.exitCode}`}]`,
        );
      else
        out.error(
          ENDED.includes(log.state)
            ? `[${log.state}${log.reason ? `, ${log.reason}` : ""}]`
            : `[${log.state}; follow it: ${me} builds logs ${id} --follow]`,
        );
      return 0;
    }
    // A follow lasts until the build ends: no deadline of the SDK's own.
    for await (const event of api.logs(id, { follow: true }, { timeoutMs: 0 })) {
      if (out.json) out.write(JSON.stringify(event));
      else if (event.type === "line") write(event);
      else if (event.type === "gap")
        out.error(
          "[older lines were dropped before they were read; going on from the oldest kept]",
        );
      if (event.type === "terminal") {
        if (!out.json) {
          out.error(`[${event.state}, ${event.reason}]`);
          if (event.failingStep)
            out.error(
              `${event.failingStep.name} failed${event.failingStep.exitCode === null ? "" : ` with exit code ${event.failingStep.exitCode}`}. Its last lines:\n${event.failingStep.lastLines.join("\n")}`,
            );
        }
        return event.state === "succeeded" ? 0 : 1;
      }
    }
    return 1;
  };
  switch (verb) {
    case "repos":
    case "repositories": {
      const [action, ...more] = rest;
      switch (action) {
        case "connect": {
          const args = parse(more, ["no-previews"], REPOSITORY_VALUES);
          const repository = need(args.positional[0], "the repository, such as acme/web");
          const given = repositorySettings(args, kit);
          if (!given.deploy)
            throw usage(
              `Give --deploy with the App it deploys: ${me} builds repos connect ${repository} --deploy web`,
            );
          const repo = await api.repositories.connect({
            ...source(repository),
            ...given,
          } as ConnectRepository);
          if (!out.json)
            out.error(
              `Connected ${repo.repository}: a push to ${repo.productionBranch} builds and deploys ${repo.deploy}. Build now: ${me} builds run ${repo.id}`,
            );
          print(repo.id, repo);
          return 0;
        }
        case "ls":
        case "list": {
          const all = await (await api.repositories.list({ limit: 100 })).toArray(Infinity);
          print(
            all.length
              ? table([
                  ["ID", "REPOSITORY", "BRANCH", "DEPLOYS", "STATE"],
                  ...all.map((r: Repository) => [
                    r.id,
                    r.repository,
                    r.productionBranch,
                    r.deploy,
                    r.state,
                  ]),
                ])
              : `No repositories. Connect one: ${me} builds repos connect acme/web --deploy web`,
            all,
          );
          return 0;
        }
        case "change":
        case "update": {
          const args = parse(more, ["no-previews"], REPOSITORY_VALUES);
          const id = need(args.positional[0], "a repository's id");
          const change = repositorySettings(args, kit);
          if (!Object.keys(change).length)
            throw usage(`Give a setting to change, such as --branch main or --start "npm start".`);
          const repo = await api.repositories.update(id, change);
          print(`${repo.repository} changed.`, repo);
          return 0;
        }
        case "disconnect":
        case "rm": {
          const repo = await api.repositories.disconnect(need(more[0], "a repository's id"));
          print(`${repo.repository} disconnected; its builds stay.`, repo);
          return 0;
        }
        case "install": {
          const link = await api.repositories.installGithub();
          print(
            `Open this within 15 minutes, install the App on the repositories Runtime may read, and confirm the organization:\n${link.url}`,
            link,
          );
          return 0;
        }
      }
      throw kit.unknown("repos command", action ?? "", [
        "connect",
        "ls",
        "change",
        "disconnect",
        "install",
      ]);
    }
    case "create":
    case "run": {
      const args = parse(rest, verb === "run" ? ["raw"] : [], ["ref", "branch", "name"]);
      const repositoryId = need(args.positional[0], "a repository's id (runtime builds repos ls)");
      const build = await api.create({
        repositoryId,
        ref: flag(args, "ref") ?? flag(args, "branch") ?? "main",
        ...(flag(args, "branch") ? { branch: flag(args, "branch")! } : {}),
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
      });
      if (verb === "create") {
        if (!out.json)
          out.error(
            `Building ${build.ref}${build.commit ? ` at ${build.commit.slice(0, 12)}` : ""}. Follow it: ${me} builds logs ${build.id} --follow`,
          );
        print(build.id, build);
        return 0;
      }
      if (!out.json)
        out.error(
          `Build ${build.id}, ${build.ref}${build.commit ? ` at ${build.commit.slice(0, 12)}` : ""}:`,
        );
      else out.write(JSON.stringify(build));
      return logs(build.id, true, has(args, "raw"));
    }
    case "ls":
    case "list": {
      const args = parse(rest, [], ["repository", "commit", "state"]);
      const commit = flag(args, "commit");
      if (commit !== undefined && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
        throw usage(
          `--commit takes a full sha in lower case: ${me} builds ls --commit $(git rev-parse HEAD)`,
        );
      const states = args.flags.get("state");
      const all = await (
        await api.list({
          limit: 100,
          ...(flag(args, "repository") ? { repositoryId: flag(args, "repository")! } : {}),
          ...(commit ? { commit } : {}),
          ...(states ? { state: states as BuildState[] } : {}),
        })
      ).toArray(Infinity);
      print(
        all.length
          ? table([["ID", "STATE", "REF", "COMMIT", "CREATED", "REASON"], ...all.map(buildRow)])
          : "No builds.",
        all,
      );
      return 0;
    }
    case "get": {
      const build = await api.get(need(rest[0], "a build's id"));
      print(JSON.stringify(build, null, 2), build);
      return 0;
    }
    case "cancel": {
      const build = await api.cancel(need(rest[0], "a build's id"));
      print(`${build.id} ${build.state}.`, build);
      return 0;
    }
    case "logs": {
      const args = parse(rest, ["f", "follow", "raw"], []);
      const id = need(args.positional[0], "a build's id");
      return logs(id, has(args, "f") || has(args, "follow"), has(args, "raw"));
    }
  }
  throw kit.unknown("builds command", verb, [
    "repos",
    "create",
    "run",
    "ls",
    "get",
    "cancel",
    "logs",
  ]);
}

const CONTAINER_STATES: readonly ContainerState[] = [
  "waiting",
  "running",
  "sleeping",
  "stopped",
  "failed",
  "deleting",
  "deleted",
];
const CONTAINER_VALUES = [
  "vcpu",
  "memory",
  "name",
  "label",
  "env",
  "entrypoint",
  "workdir",
  "user",
  "port",
  "on-exit",
];

export async function containersCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has, integer, need, pairs, envPairs, table, usage } = kit;
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(CONTAINER_HELP), { usage: named(CONTAINER_HELP) });
    return 0;
  }
  const api = containers((await client()).transport);
  /** A container's id from its id or its name: a name is looked up among the
   * containers not deleted, and must be one container's alone. */
  const idOf = async (target: string | undefined) => {
    const given = need(target, "a container's id or name");
    if (UUID.test(given)) return given;
    const found = (await api.list({ name: given })).data;
    if (found.length === 1) return found[0]!.id;
    throw usage(
      found.length
        ? `${found.length} containers are named ${given}; give one's id (${me} containers ls).`
        : `No container is named ${given}. Your containers: ${me} containers ls`,
    );
  };
  switch (verb) {
    case "create": {
      const args = parse(rest, ["sleep"], CONTAINER_VALUES);
      if (args.positional.length !== 1)
        throw usage(
          `Give one image: ${me} containers create nginx:1.27 --vcpu 1 --memory 512 [-- <command...>]`,
        );
      const image = args.positional[0]!;
      const vcpu = integer(args, "vcpu");
      const memoryMiB = integer(args, "memory");
      if (vcpu === undefined || memoryMiB === undefined)
        throw usage(
          `Give --vcpu and --memory: ${me} containers create ${image} --vcpu 1 --memory 512`,
        );
      const onExit = flag(args, "on-exit");
      if (onExit !== undefined && onExit !== "restart" && onExit !== "stop")
        throw usage("--on-exit takes restart or stop.");
      const port = integer(args, "port");
      const entrypoint = flag(args, "entrypoint");
      const workingDir = flag(args, "workdir");
      const user = flag(args, "user");
      const name = flag(args, "name");
      const input: CreateContainer = {
        image,
        vcpu,
        memoryMiB,
        ...(name === undefined ? {} : { name }),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
        ...(args.flags.has("env") ? { env: envPairs(args, env) } : {}),
        ...(entrypoint === undefined ? {} : { entrypoint: [entrypoint] }),
        ...(args.rest?.length ? { command: args.rest } : {}),
        ...(workingDir === undefined ? {} : { workingDir }),
        ...(user === undefined ? {} : { user }),
        ...(port === undefined ? {} : { port }),
        ...(onExit === undefined ? {} : { onExit }),
        ...(has(args, "sleep") ? { sleep: true } : {}),
      };
      const made = await api.create(input);
      if (!out.json)
        out.error(
          `${made.name ?? made.id} is ${made.state}, running ${made.image}. Read it: ${me} containers get ${made.name ?? made.id}`,
        );
      print(made.id, made);
      return 0;
    }
    case "ls":
    case "list": {
      const args = parse(rest, ["all"], ["state", "label"]);
      const states = args.flags.get("state");
      for (const state of states ?? [])
        if (!CONTAINER_STATES.includes(state as ContainerState))
          throw usage(`--state takes ${CONTAINER_STATES.join(", ")}.`);
      // --label key=value, as the list's key:value filters.
      const labels = Object.entries(pairs(args, "label")).map(([k, v]) => `${k}:${v}`);
      const all = await (
        await api.list({
          limit: 100,
          ...(states
            ? { state: states as ContainerState[] }
            : has(args, "all")
              ? { state: CONTAINER_STATES }
              : {}),
          ...(labels.length ? { label: labels } : {}),
        })
      ).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "NAME", "STATE", "IMAGE", "PORT", "SIZE", "CREATED"],
              ...all.map((c: Container) => [
                c.id,
                c.name ?? "-",
                c.state,
                c.image,
                c.port === null ? "-" : String(c.port),
                `${c.vcpu} vCPU, ${c.memoryMiB} MiB`,
                when(c.createdAt),
              ]),
            ])
          : `No containers. Run one: ${me} containers create nginx:1.27 --vcpu 1 --memory 512`,
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.get(await idOf(rest[0]));
      print(JSON.stringify(found, null, 2), found);
      return 0;
    }
    case "update": {
      const args = parse(rest, [], ["name", "label"]);
      const id = await idOf(args.positional[0]);
      const change: UpdateContainer = {
        ...(flag(args, "name") === undefined ? {} : { name: flag(args, "name")! }),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
      };
      if (!Object.keys(change).length)
        throw usage(
          `Give --name or --label: ${me} containers update ${args.positional[0]} --name web`,
        );
      const updated = await api.update(id, change);
      print(`${updated.name ?? updated.id} updated.`, updated);
      return 0;
    }
    case "rm":
    case "delete": {
      const args = parse(rest, ["wait"], []);
      const gone = await api.delete(await idOf(args.positional[0]), { wait: has(args, "wait") });
      print(`${gone.name ?? gone.id} ${gone.state}.`, gone);
      return 0;
    }
  }
  throw kit.unknown("containers command", verb, ["create", "ls", "get", "update", "rm"]);
}
