import { me, named } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import { RuntimeError } from "./errors.js";
import { logStream } from "./terminal.js";
import {
  apps,
  functions,
  type AppDeploy,
  type AppLogLine,
  type AppDowntime,
  type AppSettings,
  type AppVersion,
  type AppVolume,
  type CreateApp,
  type DeployApp,
  type ReleaseSettings,
  type StatefulSettings,
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

/* `runtime apps`, `runtime functions`, `runtime builds` and `runtime
   containers`, kept out of cli.ts as cli-extras.ts is. Each is in a private
   beta: a key outside it is refused product_in_beta, said in the server's
   words and hint (cli-words.ts), never as a stack. A Function is an App that
   sleeps (the API's copiesPreset, packages/cloud/src/api/products/apps.ts):
   one command serves both kinds, and a Function has no --min-copies. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
type Args = ReturnType<CliKit["parse"]>;

export const APP_HELP = `runtime apps <command>

  An App serves your web server from an image or a build. Copies start when
  requests come and stop when they end, between --min-copies and --max-copies.
  In a private beta: outside it, each command says how to ask to join.

  create [<name>] --vcpu <1-16> --memory <128-65536> --max-copies <1-1000>
         [--min-copies 0] [--concurrency 100] [--spares 2] [--port 8080]
         [--health-path /healthz] [--health-fail 60] [--stop-grace 30] [--cdn on|off]
         [--release at-once|staged] [--soak 300] [--volume <volumeId>:<path>] [--label key=value]...
                                              Make an App, waiting for its first deploy; prints its id.
                                              --health-fail: seconds a live copy may fail its health
                                              check before it is replaced. --stop-grace: seconds a
                                              stopped copy has after SIGTERM. --release staged: a new
                                              version goes live on one copy, then about 10%, 50% and
                                              all of them, each stage running --soak seconds (60 to
                                              3600) and judged on its visitors' errors and speed
                                              before the next; a stage that does worse goes back and
                                              the deploy fails, the live version never stopping.
                                              --volume mounts one
                                              volume of yours at a path under /data, /mnt, /state,
                                              /storage or /volumes, in the App's one copy: it needs
                                              --max-copies 1 (--min-copies is then 1, --spares 0), and
                                              each deploy stops the old copy before the new one boots
  ls [--all]                                  Your Apps: state, live version, copies; --all, deleted too
  get <app>                                   One App, in full (an id or its name)
  update <app> [--name <name>] [--vcpu n] [--memory n] [--min-copies n] [--max-copies n]
         [--concurrency n] [--spares n] [--port n] [--health-path /path] [--health-fail n]
         [--stop-grace n] [--volume <volumeId>:<path> | none] [--cdn on|off]
         [--release at-once|staged] [--soak n] [--label key=value]...
                                              Change its settings; --volume none takes the volume
                                              away, only before its first deploy;
                                              --cdn off sends visitors straight to Runtime's routers,
                                              with nothing cached (on: Cloudflare's CDN in front)
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
  logs <app> [--follow] [--since 1h] [--version n] [--copy <copyId>] [--stream stdout|stderr]
         [--limit 100] [--raw]                What its copies printed: the newest lines since --since
                                              (a time, or 30s, 15m, 2h, 7d; kept 14 days), or with
                                              --follow every line as it comes, until Ctrl-C. On a
                                              terminal control characters show as \\uXXXX unless --raw
  exec <app> [--copy <id>] [--root] [--cwd <dir>] [--env K=V]... [--timeout <ms>] [--trace-files <file.json>] -- <command>
                                              Run a command in its live copy
  cp <file> <app>:/<path> [--copy <id>]       Copy a file onto its live copy
  cp <app>:/<path> <file> [--copy <id>]       Copy a file off it
  exec and cp go to a serving copy of the live version unless --copy names
  one. A copy holds the App's secrets, so only an owner's or admin's key
  reaches into one. A file written to a copy lasts as long as that copy; a
  deploy replaces its copies.
  rollback <app> [--no-wait]                  Put the previous version live again
  restart <app> [--no-wait]                   Start the live version afresh, as a deploy of its own;
                                              with a volume, the old copy stops first and the
                                              downtime is said

Examples
  runtime apps create web --vcpu 1 --memory 512 --max-copies 3
  runtime apps deploy web --image web:latest --env NODE_ENV=production
  runtime apps logs web --follow
  runtime apps rollback web
  runtime apps create db --vcpu 1 --memory 1024 --max-copies 1 --volume <volumeId>:/data
`;

export const FUNCTION_HELP = `runtime functions <command>

  A Function serves your HTTP handler from an image or a build, at its own
  address. Copies start when calls come, up to --max-copies, and sleep when
  they stop: an idle Function has no copy awake.
  In a private beta: outside it, each command says how to ask to join.

  create [<name>] --vcpu <1-16> --memory <128-65536> --max-copies <1-1000>
         [--concurrency 100] [--spares 2] [--port 8080]
         [--health-path /healthz] [--health-fail 60] [--label key=value]...
                                              Make a Function, waiting for its first deploy; prints its id.
                                              --health-fail: seconds a live copy may fail its health
                                              check before it is replaced
  ls [--all]                                  Your Functions: state, live version, copies; --all, deleted too
  get <function>                              One Function, in full (an id or its name)
  update <function> [--name <name>] [--vcpu n] [--memory n] [--max-copies n]
         [--concurrency n] [--spares n] [--port n] [--health-path /path] [--health-fail n]
         [--label key=value]...
                                              Change its settings
  rm <function>                               Delete it and stop its copies
  deploy <function> (--image <image> | --build <buildId>) [--env KEY=VALUE]... [--keep-env]
         [--port 8080] [--health-path /healthz] [--no-wait]
                                              A new version. Waits until it is live, or says why it
                                              failed; --no-wait prints the deploy's id at once.
                                              --image: an image of yours (id, name, name:tag);
                                              --build: a build that succeeded (runtime builds).
                                              --env KEY alone sends KEY's value from your environment.
                                              --keep-env keeps the last deploy's environment, sealed
  deploys <function> [<deployId>] [--wait]    Each version's deploy: state and address; with an id,
                                              that one (--wait: until it ends)
  versions <function>                         Its versions; the live and previous ones keep saved copies
  copies <function>                           Its copies now: version, region, state
  logs <function> [--follow] [--since 1h] [--version n] [--copy <copyId>] [--stream stdout|stderr]
         [--limit 100] [--raw]                What its copies printed: the newest lines since --since
                                              (a time, or 30s, 15m, 2h, 7d; kept 14 days), or with
                                              --follow every line as it comes, until Ctrl-C. On a
                                              terminal control characters show as \\uXXXX unless --raw
  rollback <function> [--no-wait]             Put the previous version live again
  restart <function> [--no-wait]              Start the live version afresh, as a deploy of its own

Examples
  runtime functions create resize --vcpu 1 --memory 512 --max-copies 10
  runtime functions deploy resize --image resize:latest
  runtime functions logs resize --follow
  runtime functions rollback resize
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
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** A stop-then-start's downtime, in a person's words. */
const downtime = (d: AppDowntime | null | undefined) =>
  d ? `down ${seconds(d.totalMs)} (stop ${seconds(d.stopMs)}, boot ${seconds(d.bootMs)})` : "-";

/** What differs between the two kinds one command serves: the API's
 * factory, the words, and whether --min-copies exists (an App's only). */
type Kind = {
  api: (t: Runtime["transport"]) => ReturnType<typeof apps>;
  /** The command's own name: `runtime <command>`. */
  command: "apps" | "functions";
  one: "App" | "Function";
  many: "Apps" | "Functions";
  help: string;
  minCopies: boolean;
  /** A create's name and settings a reader can copy. */
  example: string;
};
const APP: Kind = {
  api: apps,
  command: "apps",
  one: "App",
  many: "Apps",
  help: APP_HELP,
  minCopies: true,
  example: "web --vcpu 1 --memory 512 --max-copies 2",
};
const FUNCTION: Kind = {
  // The same calls under /v1/functions; the API answers minCopies 0.
  api: functions as unknown as Kind["api"],
  command: "functions",
  one: "Function",
  many: "Functions",
  help: FUNCTION_HELP,
  minCopies: false,
  example: "resize --vcpu 1 --memory 512 --max-copies 10",
};

/** An App's or Function's id from its id or its name: a name is looked up
 * among those not deleted, and must be one's alone. */
async function appIdOf(api: ReturnType<typeof apps>, target: string, kit: CliKit, kind: Kind) {
  if (UUID.test(target)) return target;
  const found = (await api.list({ name: target, state: ["waiting", "live", "failed"] })).data;
  if (found.length === 1) return found[0]!.id;
  throw kit.usage(
    found.length
      ? `${found.length} ${kind.many} are named ${target}; give one's id (${me} ${kind.command} ls).`
      : `No ${kind.one} is named ${target}. Your ${kind.many}: ${me} ${kind.command} ls`,
  );
}

/** `--cdn on` or `--cdn off`. */
function onOff(value: string, kit: CliKit): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw kit.usage(`--cdn takes on or off, not ${value}.`);
}

/** --release at-once|staged and --soak <seconds>: how an App's new version
 * goes live. */
function releases(args: Args, kit: CliKit): Partial<ReleaseSettings> {
  const given = kit.flag(args, "release");
  const soak = kit.integer(args, "soak");
  const stages = given?.replace("-", "_");
  if (stages !== undefined && stages !== "at_once" && stages !== "staged")
    throw kit.usage(`--release takes at-once or staged, not ${given}.`);
  return {
    ...(stages === undefined ? {} : { releaseStages: stages }),
    ...(soak === undefined ? {} : { releaseSoakSeconds: soak }),
  };
}

/** --volume <volumeId>:<path>, or none (an update's: no volume). */
function volume(args: Args, kit: CliKit): { volume?: AppVolume | null } {
  const given = kit.flag(args, "volume");
  if (given === undefined) return {};
  if (given === "none") return { volume: null };
  const at = given.indexOf(":");
  const volumeId = given.slice(0, at);
  const path = given.slice(at + 1);
  if (at < 0 || !UUID.test(volumeId) || !path.startsWith("/"))
    throw kit.usage(
      `--volume takes a volume's id and where it mounts: --volume <volumeId>:/data (${me} volumes ls)`,
    );
  return { volume: { volumeId, path } };
}

/** The flags an App's settings are given with, as the API names them. A
 * Function's leave out --min-copies, --stop-grace, --volume, --release and
 * --soak, which its parse does not take. */
function settings(
  args: Args,
  kit: CliKit,
  kind: Kind,
): Partial<AppSettings & StatefulSettings & ReleaseSettings> {
  const { integer, flag } = kit;
  const number = (name: string, field: keyof (AppSettings & StatefulSettings)) =>
    integer(args, name) === undefined ? {} : { [field]: integer(args, name)! };
  return {
    ...number("vcpu", "vcpu"),
    ...number("memory", "memoryMiB"),
    ...(kind.minCopies ? number("min-copies", "minCopies") : {}),
    ...number("max-copies", "maxCopies"),
    ...number("concurrency", "concurrency"),
    ...number("spares", "spares"),
    ...number("port", "port"),
    ...(flag(args, "health-path") === undefined ? {} : { healthPath: flag(args, "health-path")! }),
    ...(flag(args, "cdn") === undefined ? {} : { cdn: onOff(flag(args, "cdn")!, kit) }),
    ...number("health-fail", "healthFailSeconds"),
    ...(kind.minCopies
      ? {
          ...number("stop-grace", "stopGraceSeconds"),
          ...volume(args, kit),
          ...releases(args, kit),
        }
      : {}),
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
  "cdn",
  "health-fail",
  "stop-grace",
  "volume",
  "release",
  "soak",
  "label",
];
const settingsOf = (kind: Kind) =>
  kind.minCopies
    ? SETTINGS
    : SETTINGS.filter(
        (name) => !["min-copies", "stop-grace", "volume", "release", "soak"].includes(name),
      );

/** A version's copies replaced while live: how many, and why. */
function replaced(list: AppVersion["replacements"] | undefined) {
  if (!list?.length) return "-";
  const health = list.filter((r) => r.reason === "health").length;
  const why = [
    health ? `${health} health` : "",
    list.length - health ? `${list.length - health} exited` : "",
  ];
  return `${list.length} (${why.filter(Boolean).join(", ")})`;
}

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

export function appsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  return copiesCommand(APP, argv, env, out, client, kit);
}

export function functionsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  return copiesCommand(FUNCTION, argv, env, out, client, kit);
}

async function copiesCommand(
  kind: Kind,
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
    print(named(kind.help), { usage: named(kind.help) });
    return 0;
  }
  const api = kind.api((await client()).transport);
  const { command, one, many } = kind;
  const idOf = (target: string | undefined) =>
    appIdOf(api, need(target, `${one === "App" ? "an" : "a"} ${one}'s id or name`), kit, kind);
  switch (verb) {
    case "create": {
      const args = parse(rest, [], settingsOf(kind));
      if (args.positional.length > 1)
        throw usage(`Give one name: ${me} ${command} create ${kind.example}`);
      const given = settings(args, kit, kind);
      if (given.volume === null)
        throw usage(`--volume none is for update: leave --volume out to make an App without one.`);
      for (const [option, field] of [
        ["vcpu", "vcpu"],
        ["memory", "memoryMiB"],
        ["max-copies", "maxCopies"],
      ] as const)
        if (given[field] === undefined)
          throw usage(
            `Give --${option}: ${me} ${command} create ${
              args.positional[0]
                ? `${args.positional[0]} ${kind.example.replace(/^\S+ /, "")}`
                : kind.example
            }`,
          );
      const input: CreateApp = {
        ...(given as CreateApp),
        ...(args.positional[0] ? { name: args.positional[0] } : {}),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
      };
      const app = await api.create(input);
      if (!out.json)
        out.error(
          `Created ${app.name ?? app.id}, waiting for its first version. Deploy one: ${me} ${command} deploy ${app.name ?? app.id} --image <image>`,
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
              ["ID", "NAME", "ADDRESS", "STATE", "LIVE", "COPIES", "SIZE", "CREATED"],
              ...all.map((a) => [
                a.id,
                a.name ?? "-",
                a.url ?? "-",
                // A copy waiting for room: its place in its region's line.
                a.line ? `${a.state} (in line, place ${a.line.place})` : a.state,
                a.liveVersion === null ? "-" : `v${a.liveVersion}`,
                // A Function's copies all sleep when idle: up to its maximum.
                kind.minCopies ? `${a.minCopies}-${a.maxCopies}` : `0-${a.maxCopies}`,
                `${a.vcpu} vCPU, ${a.memoryMiB} MiB`,
                when(a.createdAt),
              ]),
            ])
          : `No ${many}. Make one: ${me} ${command} create ${kind.example}`,
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
      const args = parse(rest, [], [...settingsOf(kind), "name"]);
      const id = await idOf(args.positional[0]);
      const change: UpdateApp = {
        ...settings(args, kit, kind),
        ...(flag(args, "name") === undefined ? {} : { name: flag(args, "name")! }),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
      };
      if (!Object.keys(change).length)
        throw usage(
          `Give a setting to change, such as ${me} ${command} update ${args.positional[0]} --max-copies 4`,
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
      // A staged App's deploy walks up to four stages, each soaking.
      const app = wait && kind.minCopies ? await api.get(id) : undefined;
      const staged =
        app && "releaseStages" in app && app.releaseStages === "staged" ? app : undefined;
      if (wait && !out.json)
        out.error(
          staged
            ? `Deploying ${args.positional[0]} in stages, each soaking ${staged.releaseSoakSeconds} s...`
            : `Deploying ${args.positional[0]}...`,
        );
      const deploy = await api.deploy(id, input, {
        timeoutMs: 15 * 60_000 + (staged ? 4 * staged.releaseSoakSeconds * 1000 : 0),
      });
      const failed = deployFailure(deploy);
      if (failed && !out.json) throw failed;
      print(
        deploy.state === "live"
          ? `Version ${deploy.version} is live at ${deploy.url}${deploy.downtime ? `, ${downtime(deploy.downtime)}` : ""}`
          : `Version ${deploy.version}: ${deploy.state}. Follow it: ${me} ${command} deploys ${args.positional[0]} ${deploy.id} --wait`,
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
              ["VERSION", "DEPLOY", "STATE", "FROM", "DOWNTIME", "ADDRESS"],
              ...deploys.map((d, i) => [
                `v${d.version}${versions[i]!.live ? " (live)" : versions[i]!.previous ? " (previous)" : ""}`,
                d.id,
                d.state,
                d.restartOf != null
                  ? `restart of v${d.restartOf}`
                  : versions[i]!.build
                    ? `build ${versions[i]!.build}`
                    : "image",
                downtime(d.downtime),
                d.url,
              ]),
            ])
          : `No deploys yet. Deploy one: ${me} ${command} deploy ${args.positional[0]} --image <image>`,
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
              ["VERSION", "LIVE", "PREVIOUS", "SAVED", "BOOT", "DEPLOY", "BUILD", "REPLACED"],
              ...versions.map((v) => [
                `v${v.version}${v.restartOf == null ? "" : ` (restart of v${v.restartOf})`}`,
                v.live ? "yes" : "-",
                v.previous ? "yes" : "-",
                v.saved ? "yes" : "-",
                v.boot ?? "-",
                v.deploy,
                v.build ?? "-",
                replaced(v.replacements),
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
          : `No copies awake. ${one === "App" ? "A request" : "A call"} starts one.`,
        copies,
      );
      return 0;
    }
    case "exec": {
      const args = parse(rest, ["root"], ["cwd", "env", "timeout", "copy", "trace-files"]);
      const command = args.rest ?? args.positional.slice(1);
      if (!command.length)
        throw usage(`Give the command after --: ${me} apps exec <app> -- ls -la`);
      const copy = await api.copy(await idOf(args.positional[0]), {
        ...(flag(args, "copy") ? { copy: flag(args, "copy")! } : {}),
      });
      return kit.execute(copy, command, args, out, env);
    }
    case "cp": {
      const args = parse(rest, [], ["copy"]);
      const [from, to] = args.positional;
      await kit.copyFile(
        need(from, "a source"),
        need(to, "a destination"),
        async (app) =>
          api.copy(await idOf(app), {
            ...(flag(args, "copy") ? { copy: flag(args, "copy")! } : {}),
          }),
        "<app>",
      );
      print(`Copied ${from} to ${to}.`, { from, to });
      return 0;
    }
    case "logs": {
      const args = parse(
        rest,
        ["f", "follow", "raw"],
        ["since", "version", "copy", "stream", "limit"],
      );
      const id = await idOf(args.positional[0]);
      const named = flag(args, "stream");
      const stream = (["stdout", "stderr"] as const).find((s) => s === named);
      if (named !== undefined && stream === undefined)
        throw usage(
          `--stream is stdout or stderr: ${me} ${command} logs ${args.positional[0]} --stream stderr`,
        );
      const version = kit.integer(args, "version");
      const limit = kit.integer(args, "limit");
      const query = {
        ...(flag(args, "since") === undefined ? {} : { since: flag(args, "since")! }),
        ...(version === undefined ? {} : { version }),
        ...(flag(args, "copy") === undefined ? {} : { copy: flag(args, "copy")! }),
        ...(stream === undefined ? {} : { stream }),
        ...(limit === undefined ? {} : { limit }),
      };
      const raw = has(args, "raw");
      const [stdout, stderr] = [logStream(process.stdout, raw), logStream(process.stderr, raw)];
      const write = (line: AppLogLine) =>
        (line.stream === "stderr" ? stderr : stdout)(
          line.text.endsWith("\n") ? line.text : `${line.text}\n`,
        );
      if (!has(args, "f") && !has(args, "follow")) {
        const page = await api.logs(id, query);
        if (out.json) out.write(JSON.stringify(page));
        else if (page.lines.length) page.lines.forEach(write);
        else
          out.error(
            `[no lines ${query.since ? `since ${query.since}` : "in the last hour"}; try --since 1d, or --follow]`,
          );
        if (!out.json && page.hasMore)
          out.error(`[older lines are kept: --since further back, or --limit up to 500]`);
        return 0;
      }
      // Until Ctrl-C: the SDK reconnects across the server's two-minute calls.
      for await (const event of api.logs(id, { ...query, follow: true }, { timeoutMs: 0 })) {
        if (out.json) out.write(JSON.stringify(event));
        else if (event.type === "line") write(event);
        else out.error("[some lines were dropped before they were read; going on]");
      }
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
    case "restart": {
      const args = parse(rest, ["no-wait"], []);
      const id = await idOf(args.positional[0]);
      const deploy = await api.restart(id, {
        wait: !has(args, "no-wait"),
        timeoutMs: 15 * 60_000,
      });
      const failed = deployFailure(deploy);
      if (failed && !out.json) throw failed;
      print(
        deploy.state === "live"
          ? `Version ${deploy.version} restarted, live at ${deploy.url}${deploy.downtime ? `, ${downtime(deploy.downtime)}` : ""}`
          : `Restarting version ${deploy.version}: ${deploy.state}. Follow it: ${me} ${command} deploys ${args.positional[0]} ${deploy.id} --wait`,
        deploy,
      );
      return failed ? 1 : 0;
    }
  }
  throw kit.unknown(`${command} command`, verb, [
    "create",
    "ls",
    "get",
    "update",
    "rm",
    "deploy",
    "deploys",
    "versions",
    "copies",
    "exec",
    "cp",
    "logs",
    "rollback",
    "restart",
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
