import type { Runtime } from "../client.js";
import type { Process, Sandbox as NativeSandbox } from "../sandbox.js";
import {
  all,
  client,
  CompatibilityError,
  create,
  destroy,
  execOptions,
  only,
  region,
  type ClientOptions,
} from "../compat/core.js";
import { GuestFiles } from "../compat/files.js";
export { CompatibilityError };
export class NotFoundError extends Error {}
export class TimeoutError extends Error {}
export class SandboxTimeoutError extends TimeoutError {}
export class App {
  constructor(
    readonly appId: string,
    readonly name?: string,
    readonly environmentName?: string,
  ) {}
}
export type SandboxCreateParams = {
  name?: string;
  cpu?: number;
  cpuLimit?: number;
  memoryMiB?: number;
  memoryLimitMiB?: number;
  timeoutMs?: number;
  workdir?: string;
  command?: string[];
  env?: Record<string, string>;
  encryptedPorts?: number[];
  blockNetwork?: boolean;
  outboundDomainAllowlist?: string[];
  outboundCidrAllowlist?: string[];
  tags?: Record<string, string>;
  regions?: string[];
  gpu?: string;
  pty?: boolean;
  secrets?: Secret[];
  experimentalEnableSnapshot?: boolean;
};
export type SandboxExecParams = {
  mode?: "text" | "binary";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
  workdir?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  pty?: boolean;
  secrets?: Secret[];
};
export class Secret {
  constructor(readonly values: Record<string, string>) {}
}
export class ModalClient {
  readonly runtime: Runtime;
  readonly apps;
  readonly images;
  readonly sandboxes: SandboxService;
  readonly secrets = { fromObject: (values: Record<string, string>) => new Secret(values) };
  constructor(
    options: ClientOptions & { tokenId?: string; tokenSecret?: string; environment?: string } = {},
  ) {
    only("Modal client", options, [
      "apiKey",
      "baseUrl",
      "fetch",
      "client",
      "timeoutMs",
      "maxRetries",
      "tokenId",
      "tokenSecret",
      "environment",
    ]);
    this.runtime = client(options);
    const runtime = this.runtime;
    this.apps = {
      fromName: async (
        name: string,
        params: { createIfMissing?: boolean; environment?: string } = {},
      ) => {
        only("Modal app", params, ["createIfMissing", "environment"]);
        if (params.environment || options.environment)
          throw new CompatibilityError("Modal", "named Modal environments");
        if (
          !params.createIfMissing &&
          !(await all(runtime, "modal")).some((s) => s.info.labels["modal.app"] === name)
        )
          throw new NotFoundError(
            `App ${name} has no Runtime sandboxes; pass createIfMissing: true.`,
          );
        return new App(name, name);
      },
    };
    this.images = {
      fromRegistry: (tag: string, secret?: Secret) => {
        if (secret)
          throw new CompatibilityError(
            "Modal",
            "registry Secret; configure Runtime image registry credentials",
          );
        return new Image(runtime, tag);
      },
      fromId: async (id: string) =>
        new Image(runtime, undefined, (await runtime.images.get(id)).id),
      fromName: async (name: string) =>
        new Image(runtime, undefined, (await runtime.images.resolve(name)).id),
      delete: (id: string) => runtime.images.delete(id),
    };
    this.sandboxes = new SandboxService(runtime);
  }
  close() {
    /* Transport has no owned background connection to close. */
  }
}
export class Image {
  private built?: string;
  constructor(
    private readonly runtime: Runtime,
    private readonly tag?: string,
    id?: string,
    private readonly commands: string[] = [],
    private readonly env: Record<string, string> = {},
    private readonly cache = true,
  ) {
    this.built = id;
  }
  get imageId() {
    if (!this.built) throw new Error("Image is not built; await image.build(app) first.");
    return this.built;
  }
  dockerfileCommands(
    commands: string[],
    params: { env?: Record<string, string>; forceBuild?: boolean } = {},
  ) {
    only("Modal image", params, ["env", "forceBuild"]);
    if (!this.tag)
      throw new CompatibilityError(
        "Modal",
        "extending a prebuilt Runtime image through Dockerfile layers",
      );
    return new Image(
      this.runtime,
      this.tag,
      undefined,
      [...this.commands, ...commands],
      { ...this.env, ...params.env },
      params.forceBuild ? false : this.cache,
    );
  }
  async build(_app?: App): Promise<Image> {
    if (!this.built) {
      const built = this.commands.length
        ? await this.runtime.images.build({
            dockerfile: [`FROM ${this.tag}`, ...this.commands].join("\n"),
            env: this.env,
            cache: this.cache,
          })
        : await this.runtime.images.build({ image: this.tag!, env: this.env, cache: this.cache });
      this.built = built.id;
    }
    return this;
  }
}
export class SandboxService {
  constructor(private readonly runtime: Runtime) {}
  async create(app: App, image: Image, params: SandboxCreateParams = {}) {
    only("Modal sandbox", params, [
      "name",
      "cpu",
      "cpuLimit",
      "memoryMiB",
      "memoryLimitMiB",
      "timeoutMs",
      "workdir",
      "command",
      "env",
      "encryptedPorts",
      "blockNetwork",
      "outboundDomainAllowlist",
      "outboundCidrAllowlist",
      "tags",
      "regions",
      "gpu",
      "pty",
      "secrets",
      "experimentalEnableSnapshot",
    ]);
    if (params.gpu) throw new CompatibilityError("Modal", "GPU allocation");
    if (params.cpuLimit !== undefined && params.cpuLimit !== params.cpu)
      throw new CompatibilityError("Modal", "separate CPU reservation and hard limit");
    if (params.memoryLimitMiB !== undefined && params.memoryLimitMiB !== params.memoryMiB)
      throw new CompatibilityError("Modal", "separate memory reservation and hard limit");
    if (params.regions && params.regions.length !== 1)
      throw new CompatibilityError("Modal", "multiple region placement");
    if (params.cpu !== undefined && !Number.isInteger(params.cpu))
      throw new CompatibilityError("Modal", "fractional CPU reservations");
    if (params.blockNetwork && (params.outboundDomainAllowlist || params.outboundCidrAllowlist))
      throw new TypeError("blockNetwork cannot be combined with allowlists");
    const placement = region("Modal", params.regions?.[0]);
    const built = await image.build(app);
    let primary: Process | undefined;
    const s = await create(
      this.runtime,
      "modal",
      {
        name: params.name ? `${app.name ?? app.appId}-${params.name}` : undefined,
        labels: {
          "modal.app": app.name ?? app.appId,
          ...(params.name ? { "modal.name": params.name } : {}),
          "modal.tags": JSON.stringify(params.tags ?? {}),
        },
        image: built.imageId,
        cpu: "reserved",
        vcpu: params.cpu,
        memoryMiB: params.memoryMiB,
        region: placement,
        timeoutSeconds: Math.ceil((params.timeoutMs ?? 300_000) / 1000),
        idlePauseSeconds: 0,
        onLeaseEnd: "stop",
        network: {
          internet: !params.blockNetwork,
          allow: [
            ...(params.outboundDomainAllowlist ?? []),
            ...(params.outboundCidrAllowlist ?? []),
          ],
        },
      },
      Object.assign(
        {} as Record<string, string>,
        ...(params.secrets?.map((s) => s.values) ?? []),
        params.env ?? {},
      ) as Record<string, string>,
      async (s) => {
        primary = await s.spawn(params.command ?? ["sleep", "infinity"], {
          ...(await execOptions(s, { cwd: params.workdir })),
          stdin: "pipe",
          pty: params.pty ? {} : undefined,
        });
        await s.update({ labels: { ...s.info.labels, "modal.entrypoint": primary.id } });
        for (const port of params.encryptedPorts ?? [])
          await s.previews.create(port, { visibility: "public" });
      },
    );
    const sandbox = new Sandbox(s, new ContainerProcess(primary!, "text"));
    sandbox.monitorEntrypoint();
    return sandbox;
  }
  async fromId(id: string) {
    const s = await this.runtime.sandboxes.get(id);
    const p = s.info.labels["modal.entrypoint"];
    if (!p) throw new NotFoundError("Sandbox is not a Modal-compatible sandbox");
    return new Sandbox(s, new ContainerProcess(await s.processes.get(p), "text"));
  }
  async fromName(appName: string, name: string) {
    const s = (await all(this.runtime, "modal")).find(
      (s) =>
        s.info.labels["modal.app"] === appName &&
        s.info.labels["modal.name"] === name &&
        s.state === "running",
    );
    if (!s) throw new NotFoundError(`Sandbox ${name} not found`);
    return this.fromId(s.id);
  }
  async *list(params: { appId?: string; tags?: Record<string, string> } = {}) {
    only("Modal list", params, ["appId", "tags"]);
    for (const s of await all(this.runtime, "modal"))
      if (
        s.state === "running" &&
        (!params.appId || s.info.labels["modal.app"] === params.appId) &&
        Object.entries(params.tags ?? {}).every(
          ([k, v]) =>
            (JSON.parse(s.info.labels["modal.tags"] ?? "{}") as Record<string, string>)[k] === v,
        )
      )
        yield await this.fromId(s.id);
  }
}
export class ModalReadStream<R extends string | Uint8Array = string> extends ReadableStream<R> {
  constructor(
    process: Process,
    channel: "stdout" | "stderr",
    mode: "text" | "binary",
    ignore = false,
  ) {
    const iterator = mode === "binary" ? process.outputBytes() : process.output();
    super({
      async pull(controller) {
        if (ignore) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              controller.close();
              return;
            }
            if (next.value.type === "truncated") throw new Error("Process output was truncated");
            if (next.value.type === channel) {
              controller.enqueue(next.value.data as R);
              return;
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    });
  }
  async readBytes() {
    const reader = this.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const bytes =
          typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value;
        chunks.push(bytes as Uint8Array);
        size += bytes.length;
      }
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
  async readText() {
    return new TextDecoder().decode(await this.readBytes());
  }
}
export class ModalWriteStream<R extends string | Uint8Array = string> extends WritableStream<R> {
  constructor(private readonly process: Process) {
    super({ write: (data) => process.write(data), close: () => process.write("", { eof: true }) });
  }
  async writeText(text: string) {
    const writer = this.getWriter();
    try {
      await writer.write(text as R);
    } finally {
      writer.releaseLock();
    }
  }
  async writeBytes(bytes: Uint8Array) {
    const writer = this.getWriter();
    try {
      await writer.write(bytes as R);
    } finally {
      writer.releaseLock();
    }
  }
}
export class ContainerProcess<R extends string | Uint8Array = string> {
  readonly stdin: ModalWriteStream<R>;
  readonly stdout: ModalReadStream<R>;
  readonly stderr: ModalReadStream<R>;
  constructor(
    readonly native: Process,
    mode: "text" | "binary",
    params: SandboxExecParams = {},
  ) {
    this.stdin = new ModalWriteStream<R>(native);
    this.stdout = new ModalReadStream<R>(native, "stdout", mode, params.stdout === "ignore");
    this.stderr = new ModalReadStream<R>(native, "stderr", mode, params.stderr === "ignore");
  }
  async wait() {
    const r = await this.native.wait();
    if (r.timedOut) throw new SandboxTimeoutError("Process timed out");
    return r.exitCode ?? -1;
  }
  closeStdin() {
    return this.native.write("", { eof: true });
  }
  async _poll() {
    const p = await this.native.refresh();
    return p.state === "running" ? null : p.exitCode;
  }
}
export class Sandbox {
  readonly filesystem: SandboxFilesystem;
  readonly stdin;
  readonly stdout;
  readonly stderr;
  private detached = false;
  private lifecycle?: Promise<number>;
  monitorEntrypoint() {
    this.lifecycle = this.primary.wait().then(async (code) => {
      await destroy(this.native);
      return code;
    });
    this.lifecycle.catch(() => undefined);
  }
  constructor(
    readonly native: NativeSandbox,
    private readonly primary: ContainerProcess,
  ) {
    this.filesystem = new SandboxFilesystem(native);
    this.stdin = primary.stdin;
    this.stdout = primary.stdout;
    this.stderr = primary.stderr;
  }
  get sandboxId() {
    return this.native.id;
  }
  exec(
    command: string[],
    params?: SandboxExecParams & { mode?: "text" },
  ): Promise<ContainerProcess<string>>;
  exec(
    command: string[],
    params: SandboxExecParams & { mode: "binary" },
  ): Promise<ContainerProcess<Uint8Array>>;
  async exec(
    command: string[],
    params: SandboxExecParams = {},
  ): Promise<ContainerProcess<string | Uint8Array>> {
    if (this.detached) throw new Error("Sandbox is detached");
    only("Modal exec", params, [
      "mode",
      "stdout",
      "stderr",
      "workdir",
      "timeoutMs",
      "env",
      "pty",
      "secrets",
    ]);
    const p = await this.native.spawn(command, {
      ...(await execOptions(this.native, {
        cwd: params.workdir,
        timeoutMs: params.timeoutMs === 0 ? 86_400_000 : params.timeoutMs,
        env: Object.assign(
          {} as Record<string, string>,
          ...(params.secrets?.map((s) => s.values) ?? []),
          params.env ?? {},
        ) as Record<string, string>,
      })),
      stdin: "pipe",
      ...(params.mode === "binary" ? { outputEncoding: "base64" as const } : {}),
      pty: params.pty ? {} : undefined,
    });
    return new ContainerProcess(p, params.mode ?? "text", params);
  }
  async setTags(tags: Record<string, string>) {
    if (this.detached) throw new Error("Sandbox is detached");
    await this.native.update({
      labels: {
        ...Object.fromEntries(
          Object.entries(this.native.info.labels).filter(
            ([k]) => k.startsWith("modal.") || k === "compat.provider",
          ),
        ),
        "modal.tags": JSON.stringify(tags),
      },
    });
  }
  async getTags(): Promise<Record<string, string>> {
    if (this.detached) throw new Error("Sandbox is detached");
    await this.native.refresh();
    return JSON.parse(this.native.info.labels["modal.tags"] ?? "{}") as Record<string, string>;
  }
  async terminate(params: { wait?: boolean } = {}) {
    await destroy(this.native);
    return params.wait ? this.primary.wait() : undefined;
  }
  detach() {
    this.detached = true;
  }
  async wait() {
    if (this.lifecycle) return this.lifecycle;
    const code = await this.primary.wait();
    await destroy(this.native);
    return code;
  }
  poll() {
    return this.primary._poll();
  }
  async tunnels() {
    return Object.fromEntries(
      (await this.native.previews.list()).map((p) => [
        p.port,
        { host: new URL(p.url).hostname, port: 443, url: p.urlWithToken ?? p.url },
      ]),
    );
  }
  async updateNetworkPolicy(params: {
    outboundCidrAllowlist: string[];
    outboundDomainAllowlist: string[];
  }) {
    await this.native.network.set({
      internet: true,
      allow: [...params.outboundCidrAllowlist, ...params.outboundDomainAllowlist],
    });
  }
  async experimentalSnapshot() {
    const snapshot = await this.native.snapshot();
    return { sandboxSnapshotId: snapshot.id };
  }
}
export class SandboxFilesystem {
  private readonly files: GuestFiles;
  constructor(private readonly native: NativeSandbox) {
    this.files = new GuestFiles(async () => native, "/");
  }
  readBytes(path: string) {
    return this.files.readFile(path);
  }
  readText(path: string) {
    return this.files.readTextFile(path);
  }
  writeBytes(content: Uint8Array | ArrayBuffer, path: string) {
    return this.files.writeFile(
      path,
      content instanceof Uint8Array ? content : new Uint8Array(content),
    );
  }
  writeText(content: string, path: string) {
    return this.files.writeTextFile(path, content);
  }
  makeDirectory(path: string, options: { createParents?: boolean } = {}) {
    return this.files.mkdir(path, options.createParents ?? true);
  }
  remove(path: string, options: { recursive?: boolean } = {}) {
    return this.files.remove(path, options.recursive);
  }
  copyFromLocal(localPath: string, remotePath: string) {
    return this.native.files.upload(localPath, remotePath);
  }
  copyToLocal(remotePath: string, localPath: string) {
    return this.native.files.download(remotePath, localPath);
  }
  async listFiles(path: string) {
    return Promise.all(
      (await this.files.readdir(path))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => this.stat(e.path)),
    );
  }
  async stat(path: string) {
    const e = await this.files.stat(path);
    const r = await this.native.exec(["stat", "-c", "%U:%G", "--", this.files.path(path)], {
      check: true,
    });
    const [owner, group] = r.stdout.trim().split(":");
    return {
      name: e.name,
      path: e.path,
      type: e.type,
      size: e.size,
      mode: parseInt(e.mode, 8),
      permissions: e.mode,
      owner: owner!,
      group: group!,
      modifiedTime: Date.parse(e.modifiedAt) / 1000,
      symlinkTarget:
        e.type === "symlink"
          ? (
              await this.native.exec(["readlink", "--", this.files.path(path)], { check: true })
            ).stdout.trimEnd()
          : null,
    };
  }
}
