import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Runtime } from "./client.js";
import { RuntimeError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";
import type { PortForward } from "./tunnel.js";
import { VERSION } from "./transport.js";

/* `runtime sandbox ssh` and `runtime sandbox port-forward`: SSH logins and TCP ports of a
   sandbox, carried over the API's authenticated tunnel (sandbox.tunnel()).
   Nothing listens on the internet for either. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export const SSH_HELP = (
  me: string,
) => `${me} sandbox ssh <id|name> [-- <command...>]   Log in over SSH (an interactive shell, or run the command)
${me} sandbox ssh config [--install]          The ssh config for \`ssh <id|name>.runtime\`, also from
                                      VS Code Remote-SSH and JetBrains Gateway; --install adds
                                      it to ~/.ssh/config
${me} sandbox ssh proxy <id|name>[.runtime]   ProxyCommand mode: SSH on stdin and stdout
${me} sandbox port-forward <id|name> <port|local:remote>... [--address 127.0.0.1]
                                      Forward local ports to ports in the sandbox, until Ctrl-C

SSH and port forwarding go through Runtime's API with your key: the sandbox opens
no port to the internet. The login is the sandbox's user, runtime, with sudo.
A paused sandbox wakes when you connect, like any command.
`;

function configDirectory(env: NodeJS.ProcessEnv): string {
  const root = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (!isAbsolute(root)) throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  return join(root, "runtime-cloud");
}

/** This machine's key for Runtime SSH logins, made on first use. Only its
 * public half ever leaves the machine, and only into the one login it opens. */
export async function sshKey(env: NodeJS.ProcessEnv): Promise<{ path: string; publicKey: string }> {
  const dir = join(configDirectory(env), "ssh");
  const path = join(dir, "id_ed25519");
  try {
    return { path, publicKey: (await readFile(`${path}.pub`, "utf8")).trim() };
  } catch {
    // Made below.
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const made = spawnSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "runtime-cloud", "-f", path],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (made.error || made.status !== 0)
    throw new RuntimeError({
      message: `Could not make an SSH key with ssh-keygen${made.error ? `: ${made.error.message}` : `: ${made.stderr.toString().trim()}`}.`,
      code: "ssh_keygen_failed",
      status: 0,
      hint: "Install OpenSSH (it has ssh and ssh-keygen), or pass --key with a public key file.",
    });
  return { path, publicKey: (await readFile(`${path}.pub`, "utf8")).trim() };
}

/** A sandbox by id or by its name, as `ssh` hands it over (`<id>.runtime`). */
export async function resolveSandbox(runtime: Runtime, target: string): Promise<Sandbox> {
  const name = target.replace(/\.runtime$/, "");
  if (UUID.test(name)) return runtime.sandboxes.get(name);
  const page = await runtime.sandboxes.list({ name, limit: 2 });
  if (page.data.length === 1) return page.data[0]!;
  throw new RuntimeError({
    message: page.data.length
      ? `More than one live sandbox is named ${name}.`
      : `No live sandbox is named ${name}.`,
    code: page.data.length ? "ambiguous_name" : "sandbox_not_found",
    status: 0,
    hint: "Use its id: runtime sandbox ls",
  });
}

const quote = (text: string) =>
  /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
/** How ssh should start this CLI again: the same program and script, or npx
 * at this version when it ran from npx's temporary cache. */
function selfCommand(env: NodeJS.ProcessEnv): string {
  const script = process.argv[1];
  const program =
    script && !/[\\/]_npx[\\/]/.test(script)
      ? [process.execPath, realpathSync(script)]
      : ["npx", "--yes", `withruntime@${VERSION}`];
  const origin = env.RUNTIME_API_URL ? [`RUNTIME_API_URL=${env.RUNTIME_API_URL}`] : [];
  return [...(origin.length ? ["env", ...origin] : []), ...program].map(quote).join(" ");
}

export async function sshConfig(env: NodeJS.ProcessEnv): Promise<string> {
  const { path } = await sshKey(env);
  return `# Runtime Cloud: \`ssh <sandbox id or name>.runtime\`, and the same host in
# VS Code Remote-SSH or JetBrains Gateway. The connection is Runtime's
# authenticated tunnel, which already proves which sandbox answers; each login
# gets a fresh host key, so there is nothing to pin in known_hosts.
Host *.runtime
  User runtime
  ProxyCommand ${selfCommand(env)} sandbox ssh proxy %h
  IdentityFile "${path}"
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
  ServerAliveInterval 30
`;
}

/** Writes the block to its own file and includes it from ~/.ssh/config once. */
async function installConfig(env: NodeJS.ProcessEnv): Promise<string> {
  const file = join(configDirectory(env), "ssh", "config");
  await writeFile(file, await sshConfig(env), { mode: 0o600 });
  const sshDir = join(homedir(), ".ssh");
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  const main = join(sshDir, "config");
  const current = await readFile(main, "utf8").catch(() => "");
  const include = `Include "${file}"`;
  if (!current.split("\n").some((line) => line.trim() === include))
    // First, because ssh reads an Include inside a Host block as part of it.
    await writeFile(main, `${include}\n${current ? `\n${current}` : ""}`, { mode: 0o600 });
  return file;
}

/** ProxyCommand mode: ssh speaks on this process's stdin and stdout. */
async function proxy(runtime: Runtime, target: string, publicKey: string): Promise<number> {
  const sbx = await resolveSandbox(runtime, target);
  const tunnel = await sbx.tunnel();
  const stream = await tunnel.ssh(publicKey).catch((error: unknown) => {
    tunnel.close();
    throw error;
  });
  return new Promise<number>(() => {
    // When the sandbox side ends, the session is over: flush what ssh has not
    // read yet, then exit, which is what closes the pipe ssh is reading (an
    // ended process.stdout does not close it on every runtime).
    let leaving = false;
    const leave = (code: number) => {
      if (leaving) return;
      leaving = true;
      tunnel.close();
      process.stdout.write("", () => process.exit(code));
    };
    stream.onData = (data) => void process.stdout.write(data);
    stream.onEnd = () => leave(0);
    stream.onLog = (text) => process.stderr.write(`sandbox sshd: ${text}`);
    stream.onClose = (reason) => {
      if (reason !== "done")
        process.stderr.write(`Runtime: the SSH connection ended (${reason}).\n`);
      leave(reason === "done" ? 0 : 1);
    };
    // Async iteration reads the next chunk only after this one is inside the
    // window: backpressure that behaves the same on Node and Bun.
    void (async () => {
      for await (const data of process.stdin as AsyncIterable<Buffer>)
        await stream.write(new Uint8Array(data));
      stream.end();
    })().catch(() => stream.close());
  });
}

/** Installs the OpenSSH server in a sandbox that lacks it (an image made
 * before it was in the base image, or a custom one), saying so first. */
async function ensureSshd(sbx: Sandbox, out: Out): Promise<void> {
  const probe = await sbx.exec(["sh", "-c", "command -v sshd || test -x /usr/sbin/sshd"], {
    timeoutMs: 30_000,
  });
  if (probe.exitCode === 0) return;
  out.error("This sandbox has no OpenSSH server yet; installing it once...");
  const installed = await sbx.exec(
    [
      "sh",
      "-c",
      "sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server",
    ],
    { timeoutMs: 300_000 },
  );
  if (installed.exitCode !== 0)
    throw new RuntimeError({
      message: `Installing openssh-server in the sandbox failed: ${(installed.stderr || installed.stdout).trim().slice(-400)}`,
      code: "sshd_missing",
      status: 0,
      hint: "Install an SSH server in the sandbox yourself, or build an image that has one.",
    });
}

export async function sshCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  connect: () => Promise<Runtime>,
  me: string,
): Promise<number> {
  const dash = argv.indexOf("--");
  const words = dash === -1 ? argv : argv.slice(0, dash);
  const remote = dash === -1 ? [] : argv.slice(dash + 1);
  const keyAt = words.indexOf("--key");
  const keyFile = keyAt === -1 ? undefined : words[keyAt + 1];
  const positional = words.filter(
    (word, i) => !word.startsWith("--") && (keyAt === -1 || i !== keyAt + 1),
  );
  const [first, second] = positional;
  if (!first || first === "help") {
    out.write(SSH_HELP(me));
    return first ? 0 : 64;
  }
  const publicKey = async () =>
    keyFile ? (await readFile(keyFile, "utf8")).trim() : (await sshKey(env)).publicKey;
  if (first === "config") {
    if (words.includes("--install")) {
      const file = await installConfig(env);
      out.write(
        out.json
          ? JSON.stringify({ installed: file })
          : `Added Include "${file}" to ~/.ssh/config. Connect with: ssh <sandbox id or name>.runtime`,
      );
    } else
      out.write(out.json ? JSON.stringify({ config: await sshConfig(env) }) : await sshConfig(env));
    return 0;
  }
  if (first === "proxy") {
    if (!second) throw usageError(`Give the host: ${me} sandbox ssh proxy <id>.runtime`, me);
    return proxy(await connect(), second, await publicKey());
  }
  const runtime = await connect();
  const sbx = await resolveSandbox(runtime, first);
  await ensureSshd(sbx, out);
  const key = keyFile ? undefined : await sshKey(env);
  const args = [
    "-o",
    `ProxyCommand=${selfCommand(env)} sandbox ssh proxy${keyFile ? ` --key ${quote(keyFile)}` : ""} %h`,
    ...(key ? ["-i", key.path, "-o", "IdentitiesOnly=yes"] : []),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ServerAliveInterval=30",
    ...(remote.length ? [] : ["-t"]),
    `runtime@${sbx.id}.runtime`,
    // ssh joins what follows the host into one remote command line.
    ...remote,
  ];
  return new Promise<number>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", (error) =>
      reject(
        new RuntimeError({
          message: `Could not run ssh: ${error.message}`,
          code: "ssh_missing",
          status: 0,
          hint: "Install OpenSSH, or use `runtime sandbox shell <id>`, which needs nothing.",
        }),
      ),
    );
    child.on("exit", (code) => resolve(code ?? 255));
  });
}

function usageError(message: string, me: string) {
  return new RuntimeError({
    message,
    code: "usage",
    status: 0,
    hint: `Run \`${me} sandbox ssh help\`.`,
  });
}

/** `runtime sandbox port-forward <id> 5432 8080:3000 ...` */
export async function portForwardCommand(
  argv: string[],
  out: Out,
  connect: () => Promise<Runtime>,
  me: string,
): Promise<number> {
  const at = argv.indexOf("--address");
  const address = at === -1 ? "127.0.0.1" : argv[at + 1];
  const positional = argv.filter(
    (word, i) => !word.startsWith("--") && (at === -1 || i !== at + 1),
  );
  const [target, ...specs] = positional;
  if (!target || !specs.length || !address)
    throw new RuntimeError({
      message: `Give a sandbox and at least one port: ${me} sandbox port-forward <id> 5432 8080:3000`,
      code: "usage",
      status: 0,
      hint: `Run \`${me} sandbox ssh help\`.`,
    });
  const ports = specs.map((spec) => {
    const match = /^(?:(\d{1,5}):)?(\d{1,5})$/.exec(spec);
    const remote = Number(match?.[2]);
    const local = match?.[1] === undefined ? remote : Number(match[1]);
    if (!match || remote < 1 || remote > 65_535 || local > 65_535)
      throw new RuntimeError({
        message: `${spec} is not a port or local:remote pair.`,
        code: "usage",
        status: 0,
        hint: "For example 5432, or 15432:5432 to listen on 15432 here.",
      });
    return { local, remote };
  });
  const sbx = await resolveSandbox(await connect(), target);
  const tunnel = await sbx.tunnel();
  const forwards: PortForward[] = [];
  /* A connection the sandbox refused is closed at once, which a browser or
     curl reports only as an empty reply, so say why here, once per reason. */
  const said = new Set<string>();
  const refused = (remote: number) => (error: RuntimeError) => {
    const line = `Port ${remote}: ${error.message}${error.hint ? ` ${error.hint}` : ""}`;
    if (said.has(line)) return;
    said.add(line);
    out.error(
      out.json
        ? JSON.stringify({ port: remote, error: { code: error.code, message: error.message } })
        : line,
    );
  };
  try {
    for (const { local, remote } of ports)
      forwards.push(
        await tunnel.forward(remote, { localPort: local, host: address, onError: refused(remote) }),
      );
  } catch (error) {
    tunnel.close();
    throw new RuntimeError({
      message: `Could not listen here: ${error instanceof Error ? error.message : String(error)}`,
      code: "listen_failed",
      status: 0,
      hint: "Pick another local port with local:remote, for example 15432:5432.",
    });
  }
  out.write(
    out.json
      ? JSON.stringify({
          sandboxId: sbx.id,
          forwarding: forwards.map((f) => ({
            address: f.host,
            localPort: f.localPort,
            port: f.port,
          })),
        })
      : forwards
          .map((f) => `Forwarding ${f.host}:${f.localPort} -> sandbox ${sbx.id} port ${f.port}`)
          .join("\n") + "\nPress Ctrl-C to stop.",
  );
  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = () => {
      stopping = true;
      process.off("SIGINT", stop);
      void Promise.all(forwards.map((f) => f.close())).then(() => {
        tunnel.close();
        resolve(0);
      });
    };
    process.once("SIGINT", stop);
    void tunnel.closed.then((reason) => {
      if (stopping) return;
      process.off("SIGINT", stop);
      out.error(`The tunnel closed: ${reason}`);
      void Promise.all(forwards.map((f) => f.close())).then(() => resolve(1));
    });
  });
}
