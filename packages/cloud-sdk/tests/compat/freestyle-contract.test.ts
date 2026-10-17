/** freestyle 0.2.20's PTY sessions, Linux users, firewall rules, errors and
 * snapshot updates on Runtime, against simulated native clients. */
import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { ConnectionError, NotFoundError } from "../../src/errors.js";
import {
  CompatibilityError,
  connectXterm,
  Freestyle,
  FreestyleApiError,
  FreestyleTransportError,
  FirewallRuleValidationError,
  sessionNumber,
  validateFirewallRule,
  Vm,
  VmPty,
  VpcNamespace,
  type XtermTerminal,
} from "../../src/freestyle/index.js";
import type { ProcessInfo } from "../../src/types.js";
import type { Sandbox } from "../../src/sandbox.js";

const VM = "00000000-0000-4000-8000-000000000001";

/** A sandbox whose processes and terminals are recorded. */
function guest() {
  const processes: ProcessInfo[] = [];
  const calls: string[] = [];
  const execs: { command: unknown; options: Record<string, unknown> }[] = [];
  const terminals: {
    processId: string;
    closed: boolean;
    finish: (code: number | null) => void;
    emit?: (data: Uint8Array) => void;
    sent: string[];
  }[] = [];
  const sandbox = {
    id: VM,
    async spawn(command: string, options: { pty?: { cols: number; rows: number } }) {
      calls.push(`spawn ${command}`);
      const info = {
        id: `proc-${processes.length + 1}`,
        kind: "process",
        state: "running",
        exitCode: null,
        command,
        cwd: "/workspace",
        pty: !!options.pty,
        startedAt: new Date(1_700_000_000_000 + processes.length * 1000).toISOString(),
      } as ProcessInfo;
      processes.push(info);
      return { toJSON: () => info };
    },
    async terminal(options: { processId: string; onData?: (d: Uint8Array) => void }) {
      calls.push(`attach ${options.processId}`);
      let finish!: (code: number | null) => void;
      const exited = new Promise<number | null>((resolve) => (finish = resolve));
      const record = {
        processId: options.processId,
        closed: false,
        finish,
        emit: options.onData,
        sent: [] as string[],
      };
      terminals.push(record);
      return {
        exited,
        write: (data: string | Uint8Array) => {
          record.sent.push(`write ${String(data)}`);
          calls.push(`write ${String(data)}`);
        },
        resize: (cols: number, rows: number) => {
          record.sent.push(`resize ${cols}x${rows}`);
          calls.push(`resize ${cols}x${rows}`);
        },
        close: () => {
          record.closed = true;
          finish(null);
        },
      };
    },
    processes: {
      list: async () => processes,
      get: async (id: string) => {
        calls.push(`process ${id}`);
        const info = processes.find((p) => p.id === id);
        if (!info)
          throw new NotFoundError({ message: "no process", code: "not_found", status: 404 });
        return {
          state: info.state,
          exitCode: info.exitCode,
          kill: async (signal: string) => {
            calls.push(`kill ${id} ${signal}`);
            const info = processes.find((p) => p.id === id)!;
            info.state = "killed";
            info.exitCode = 137;
          },
        };
      },
    },
    async exec(command: unknown, options: Record<string, unknown>) {
      execs.push({ command, options });
      return { stdout: "out", stderr: "", exitCode: 0, timedOut: false };
    },
    files: {
      readText: async () => JSON.stringify({ SAVED: "1" }),
    },
  };
  const runtime = {
    sandboxes: {
      async get(id: string) {
        calls.push(`get ${id}`);
        return sandbox;
      },
    },
  } as unknown as Runtime;
  return { runtime, sandbox: sandbox as unknown as Sandbox, processes, calls, execs, terminals };
}

describe("PTY sessions", () => {
  test("open starts a terminal process that outlives its connection", async () => {
    const g = guest();
    const pty = new VmPty(async () => g.sandbox);
    const session = await pty.open({ exec: "top", cols: 100, rows: 30 });
    expect(g.processes[0]!.command).toBe(": freestyle-pty slug= user= cols=100 rows=30; top");
    expect(g.processes[0]!.pty).toBe(true);
    expect(session.created).toBe(true);
    expect(session.sessionId).toBe(sessionNumber("proc-1"));
    expect(session.slug).toBeUndefined();
    session.write("ls\n");
    session.resize({ cols: 120, rows: 40 });
    session.detach();
    expect(session.readyState).toBe(2);
    expect(g.terminals[0]!.closed).toBe(true);
    // Detaching never signals the process.
    expect(g.calls.some((c) => c.startsWith("kill"))).toBe(false);
    expect(g.processes[0]!.state).toBe("running");
    expect(g.calls).toContain("write ls\n");
    expect(g.calls).toContain("resize 120x40");
  });

  test("a slug is get-or-create while its shell runs, and released when it exits", async () => {
    const g = guest();
    const pty = new VmPty(async () => g.sandbox);
    const first = await pty.open({ slug: "main", exec: "echo once" });
    const again = await pty.open({ slug: "main", exec: "echo twice" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.sessionId).toBe(first.sessionId);
    expect(g.processes).toHaveLength(1);
    g.processes[0]!.state = "exited";
    g.processes[0]!.exitCode = 0;
    const fresh = await pty.open({ slug: "main" });
    expect(fresh.created).toBe(true);
    expect(g.processes).toHaveLength(2);
    expect(g.processes[1]!.command).toBe(
      ": freestyle-pty slug=main user= cols=80 rows=24; exec bash -l",
    );
  });

  test("attach finds a session by number or slug, and a missing one is NOT_FOUND", async () => {
    const g = guest();
    const pty = new VmPty(async () => g.sandbox);
    const opened = await pty.open({ slug: "work" });
    expect((await pty.attach({ session: opened.sessionId })).created).toBe(false);
    expect((await pty.attach({ session: "work" })).sessionId).toBe(opened.sessionId);
    const missing = await pty.attach({ session: "nope" }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(FreestyleApiError);
    expect(missing).toMatchObject({ status: 404, code: "NOT_FOUND" });
    // A session of another user is not this user's.
    await expect(pty.attach({ session: "work", linuxUser: "dev" })).rejects.toMatchObject({
      status: 404,
    });
  });

  test("list reports state, size, user and exit; close ends a running shell", async () => {
    const g = guest();
    const pty = new VmPty(async () => g.sandbox);
    const root = await pty.open({ slug: "a" });
    await pty.open({ linuxUser: "dev", exec: "vim" });
    expect(g.processes[1]!.command).toBe(
      ": freestyle-pty slug= user=dev cols=80 rows=24; exec sudo -n -H -u 'dev' -- bash -c 'vim'",
    );
    const listed = (await pty.list()).sessions;
    expect(listed).toEqual([
      {
        sessionId: root.sessionId,
        state: "running",
        createdUnix: 1_700_000_000,
        cols: 80,
        rows: 24,
        linuxUser: null,
        slug: "a",
      },
      expect.objectContaining({ linuxUser: "dev", slug: null, state: "running" }),
    ]);
    expect((await pty.list({ linuxUser: "dev" })).sessions).toHaveLength(1);
    expect(await pty.close("a")).toEqual({ sessionId: root.sessionId });
    expect(g.calls).toContain("kill proc-1 SIGKILL");
    // Closing an exited session reports its exit and signals nothing.
    const kills = g.calls.filter((c) => c.startsWith("kill")).length;
    expect(await pty.close(root.sessionId)).toEqual({ sessionId: root.sessionId, exitCode: 137 });
    expect(g.calls.filter((c) => c.startsWith("kill")).length).toBe(kills);
    // Processes that are not PTY sessions are not listed.
    g.processes.push({ ...g.processes[0]!, id: "plain", pty: false, command: "sleep 9" });
    expect((await pty.list()).sessions).toHaveLength(2);
  });

  test("exit and close events come from the terminal", async () => {
    const g = guest();
    const events: unknown[] = [];
    const session = await new VmPty(async () => g.sandbox).open({
      onExit: (code) => events.push(["exit", code]),
      onClose: (info) => events.push(["close", info.code]),
    });
    g.terminals[0]!.finish(3);
    await Bun.sleep(0);
    expect(events).toEqual([
      ["exit", 3],
      ["close", 1000],
    ]);
    expect(session.readyState).toBe(3);
  });

  test("signal sends the process SIGINT or SIGKILL", async () => {
    const g = guest();
    const session = await new VmPty(async () => g.sandbox).open();
    session.signal("sigint");
    await Bun.sleep(0);
    expect(g.calls).toContain("kill proc-1 SIGINT");
    expect(() => session.signal("sigterm" as "sigint")).toThrow(TypeError);
  });

  test("bad options refuse before the sandbox is touched", async () => {
    const g = guest();
    let touched = false;
    const pty = new VmPty(async () => {
      touched = true;
      return g.sandbox;
    });
    await expect(pty.open({ replaceOnExit: true } as object)).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    for (const bad of [{ slug: "123" }, { slug: "Bad" }, { cols: 0 }, { linuxUser: "a b" }])
      await expect(pty.open(bad)).rejects.toBeInstanceOf(TypeError);
    expect(touched).toBe(false);
  });
});

describe("PTY connections (freestyle 0.2.18)", () => {
  const until = async (check: () => boolean) => {
    // reconnect() without options waits Freestyle's first backoff, 400ms ± 30%.
    for (const end = Date.now() + 3_000; !check() && Date.now() < end;) await Bun.sleep(2);
    expect(check()).toBe(true);
  };

  test("reconnect reattaches the same shell after a dropped connection, at its last size", async () => {
    const g = guest();
    const states: string[] = [];
    const data: string[] = [];
    const session = await new VmPty(async () => g.sandbox).open({
      slug: "main",
      reconnect: { initialDelayMs: 1 },
      onStateChange: (state) => states.push(state),
      onData: (bytes) => data.push(new TextDecoder().decode(bytes)),
    });
    expect(session.state).toBe("connected");
    await session.ready;
    session.resize({ cols: 132, rows: 50 });
    g.terminals[0]!.finish(null); // the connection drops; the shell runs on
    await until(() => g.terminals.length === 2 && session.state === "connected");
    expect(states).toEqual(["connected", "reconnecting", "connected"]);
    expect(g.terminals[1]!.processId).toBe("proc-1");
    expect(g.processes).toHaveLength(1);
    expect(g.terminals[1]!.sent).toEqual(["resize 132x50"]);
    // Output of the retired connection is dropped; the new one's arrives.
    g.terminals[0]!.emit!(new TextEncoder().encode("stale"));
    g.terminals[1]!.emit!(new TextEncoder().encode("fresh"));
    expect(data).toEqual(["fresh"]);
    session.write("ls\n");
    expect(g.terminals[1]!.sent).toContain("write ls\n");
    session.detach();
  });

  test("without reconnect a drop closes the session; writes throw; reconnect() reattaches", async () => {
    const g = guest();
    const closes: unknown[] = [];
    const session = await new VmPty(async () => g.sandbox).open({
      onClose: (info) => closes.push(info),
    });
    g.terminals[0]!.finish(null);
    await until(() => session.state === "closed");
    expect(closes).toEqual([{ wasClean: false, code: 1006, reason: "Connection lost" }]);
    expect(() => session.write("x")).toThrow("PTY is not connected");
    expect(() => session.signal("sigint")).toThrow("PTY is not connected");
    session.reconnect();
    await until(() => session.state === "connected");
    expect(g.terminals).toHaveLength(2);
    session.detach();
    expect(closes).toEqual([
      { wasClean: false, code: 1006, reason: "Connection lost" },
      { wasClean: true, code: 1000, reason: "Detached" },
    ]);
    expect(session.state).toBe("closed");
    session.detach();
    expect(closes).toHaveLength(2);
  });

  test("a session that is gone ends recovery with NOT_FOUND instead of retrying", async () => {
    const g = guest();
    const errors: unknown[] = [];
    const session = await new VmPty(async () => g.sandbox).open({
      reconnect: { initialDelayMs: 1 },
      onError: (error) => errors.push(error),
    });
    g.processes.length = 0; // its sandbox was recreated: the process no longer exists
    g.terminals[0]!.finish(null);
    await until(() => session.state === "closed");
    expect(errors[0]).toBeInstanceOf(FreestyleApiError);
    expect(errors[0]).toMatchObject({ status: 404 });
    expect(g.terminals).toHaveLength(1);
  });

  test("a shell killed by a signal ends as exited, without an exit code", async () => {
    const g = guest();
    const events: unknown[] = [];
    const session = await new VmPty(async () => g.sandbox).open({
      reconnect: true,
      onExit: (code) => events.push(["exit", code]),
      onClose: (info) => events.push(["close", info.code]),
    });
    g.processes[0]!.state = "killed";
    g.terminals[0]!.finish(null);
    await until(() => session.state === "exited");
    expect(events).toEqual([["close", 1000]]);
    expect(g.terminals).toHaveLength(1);
  });

  test("timers are checked like Freestyle's, before the sandbox is touched", async () => {
    let touched = false;
    const pty = new VmPty(async () => {
      touched = true;
      return guest().sandbox;
    });
    for (const bad of [
      { connectTimeoutMs: 0 },
      { connectTimeoutMs: Number.NaN },
      { reconnect: { timeoutMs: Infinity } },
      { reconnect: { maxDelayMs: -1 } },
      { reconnect: { initialDelayMs: 2 ** 31 } },
    ])
      await expect(pty.open(bad)).rejects.toBeInstanceOf(RangeError);
    await expect(pty.attach({ session: 1, connectTimeoutMs: -5 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(pty.open({ reconnect: { jitter: 1 } } as object)).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    expect(touched).toBe(false);
  });

  test("a first connection that does not come up within connectTimeoutMs fails", async () => {
    const g = guest();
    let closedLate = false;
    (g.sandbox as unknown as { terminal: unknown }).terminal = () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              exited: new Promise(() => {}),
              close: () => (closedLate = true),
            }),
          30,
        ),
      );
    const error = await new VmPty(async () => g.sandbox)
      .open({ connectTimeoutMs: 5 })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe("PTY handshake timed out");
    await until(() => closedLate);
  });

  test("connectXterm resets the screen, mutes replayed queries and detaches on dispose", async () => {
    const g = guest();
    const writes: unknown[] = [];
    const handlers: { disposed: boolean }[] = [];
    let input!: (data: string) => void;
    const handler = () => {
      const h = { disposed: false, dispose: () => (h.disposed = true) };
      handlers.push(h);
      return h;
    };
    const terminal: XtermTerminal = {
      cols: 100,
      rows: 30,
      write: (data, callback) => {
        writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        callback?.();
      },
      onData: (listener) => {
        input = listener;
        return handler();
      },
      onResize: () => handler(),
      parser: { registerCsiHandler: handler, registerDcsHandler: handler },
    };
    const vm = new Vm(g.runtime, VM);
    const xterm = await connectXterm({ pty: vm.pty, terminal, slug: "main" });
    const { session } = xterm;
    expect(g.processes[0]!.command).toBe(
      ": freestyle-pty slug=main user= cols=100 rows=30; exec bash -l",
    );
    expect(writes[0]).toBe("\x1bc");
    expect(handlers.filter((h) => !h.disposed)).toHaveLength(8 + 2); // 8 muted + input + resize
    g.terminals[0]!.emit!(new TextEncoder().encode("$ "));
    expect(writes).toContain("$ ");
    await until(() => handlers.slice(0, 8).every((h) => h.disposed));
    input("pwd\r");
    expect(g.terminals[0]!.sent).toContain("write pwd\r");
    xterm.dispose();
    expect(session.state).toBe("closed");
    expect(g.terminals[0]!.closed).toBe(true);
    expect(g.calls.some((c) => c.startsWith("kill"))).toBe(false);
  });
});

describe("Linux users", () => {
  test("exec as a user keeps the environment by name, its values off the command line", async () => {
    const g = guest();
    const vm = new Vm(g.runtime, VM);
    const result = await vm
      .linuxUser("dev")
      .exec({ command: "echo $A", env: { A: "secret-value-7" } });
    expect(result).toEqual({ stdout: "out", stderr: "", statusCode: 0 });
    expect(g.execs[0]!.command).toBe(
      "exec sudo -n -H --preserve-env=SAVED,A -u 'dev' -- bash -c 'echo $A'",
    );
    expect(g.execs[0]!.command).not.toContain("secret-value-7");
    expect(g.execs[0]!.options.env).toEqual({ SAVED: "1", A: "secret-value-7" });
    // Without a user, the command runs as before.
    await vm.exec("id");
    expect(g.execs[1]!.command).toBe("id");
  });

  test("an invalid user name is refused before any call", async () => {
    const g = guest();
    const vm = new Vm(g.runtime, VM);
    await expect(vm.exec({ command: "id", linuxUser: "root;rm" })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(() => vm.linuxUser("Bad User")).toThrow(TypeError);
    expect(g.calls).toEqual([]);
  });
});

describe("errors and refusals", () => {
  test("a Runtime error becomes FreestyleApiError with its code, status and cause", async () => {
    const native = new NotFoundError({
      message: "no such sandbox",
      code: "not_found",
      status: 404,
    });
    const runtime = {
      sandboxes: {
        get: async () => {
          throw native;
        },
      },
    } as unknown as Runtime;
    const error = await new Vm(runtime, VM).data().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreestyleApiError);
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, message: "no such sandbox" });
    expect((error as Error).cause).toBe(native);
  });

  test("a call that got no answer becomes FreestyleTransportError, a TypeError, not FreestyleApiError", async () => {
    const native = new ConnectionError({
      message: "no answer",
      code: "connection_error",
      status: 0,
    });
    const runtime = {
      sandboxes: {
        get: async () => {
          throw native;
        },
      },
    } as unknown as Runtime;
    const error = await new Vm(runtime, VM).data().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreestyleTransportError);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(FreestyleApiError);
    expect((error as Error).cause).toBe(native);
    expect((error as FreestyleTransportError).errors).toEqual([
      { name: "ConnectionError", message: "no answer", code: "connection_error" },
    ]);
    expect(JSON.parse(JSON.stringify(error)).errors).toHaveLength(1);
  });

  test("vendor products Runtime does not sell refuse by name", async () => {
    const freestyle = new Freestyle({ apiKey: "rtcloud_x" });
    expect(() => freestyle.vpc).toThrow(/vpc.*runtime\.networks\.private/);
    expect(() => freestyle.firewall).toThrow(CompatibilityError);
    expect(() => freestyle.tls).toThrow(CompatibilityError);
    expect(() => freestyle.tunnels).toThrow(CompatibilityError);
    await expect(freestyle.fetch("/v5/vms")).rejects.toBeInstanceOf(CompatibilityError);
    expect(() => validateFirewallRule({}, "rule")).toThrow(CompatibilityError);
    expect(() => new (VpcNamespace as unknown as new () => object)()).toThrow(CompatibilityError);
    await expect(new Vm({} as Runtime, VM).resize({ cpu: 4 })).rejects.toThrow(/restarting/);
    expect(() => new Freestyle({ apiKey: "rtcloud_x", teamId: "t" })).toThrow(CompatibilityError);
    expect(() => new Freestyle({ apiKey: "rtcloud_x", stackAccessToken: "s" })).toThrow(
      CompatibilityError,
    );
  });
});

describe("firewall rules", () => {
  function creating() {
    const created: Record<string, unknown>[] = [];
    const sandbox = {
      id: VM,
      info: { name: null, labels: {}, vcpu: 2, memoryMiB: 4096, diskMiB: 4096, createdAt: "t" },
      state: "running",
      files: { write: async () => undefined },
      network: {
        get: async () => policy,
      },
    };
    let policy = {
      internet: true,
      allow: [] as string[],
      deny: [] as string[],
      connect: [] as string[],
      updatedAt: null,
    };
    const runtime = {
      sandboxes: {
        create: async (input: Record<string, unknown>) => {
          created.push(input);
          return sandbox;
        },
        get: async () => sandbox,
      },
    } as unknown as Runtime;
    return {
      created,
      vms: new Freestyle({ client: runtime }).vms,
      vm: new Vm(runtime, VM),
      set: (next: Partial<typeof policy>) => (policy = { ...policy, ...next }),
    };
  }

  test("CIDR destinations narrow the VM's outbound network; public opens it", async () => {
    const c = creating();
    const result = await c.vms.create({
      firewall: {
        rules: [
          { action: "allow", source: {}, destination: { cidr: "203.0.113.0/24" } },
          {
            action: "allow",
            source: {},
            destination: { cidr: "198.51.100.7", port: 443, protocol: "tcp" },
          },
          {
            action: "allow",
            source: {},
            destination: { cidr: "198.51.100.7/32", port: 80, protocol: "tcp" },
          },
        ],
      },
    });
    expect(c.created[0]!.network).toEqual({
      internet: true,
      allow: ["203.0.113.0/24", "198.51.100.7/32"],
    });
    expect(result.firewallRules.map((r) => [r.id, r.source])).toEqual([
      [`runtime-network-${VM}-0`, { vmId: VM }],
      [`runtime-network-${VM}-1`, { vmId: VM }],
      [`runtime-network-${VM}-2`, { vmId: VM }],
    ]);
    await c.vms.create({
      firewall: {
        rules: [
          { action: "allow", source: {}, destination: { cidr: "203.0.113.0/24" } },
          { action: "allow", source: {}, destination: { public: true } },
        ],
      },
    });
    expect(c.created[1]!.network).toEqual({ internet: true });
    await c.vms.create({ firewall: { rules: [] } });
    expect(c.created[2]!.network).toEqual({ internet: false });
  });

  test("rules Runtime cannot keep refuse before allocation", async () => {
    const c = creating();
    const rule = (destination: object, source: object = {}) => ({
      firewall: { rules: [{ action: "allow" as const, source, destination }] },
    });
    for (const options of [
      rule({ public: true, port: 22, protocol: "tcp" }),
      // Runtime opens 80 and 443 together: one alone would widen the rule.
      rule({ public: true, port: 443, protocol: "tcp" }),
      rule({ cidr: "198.51.100.7", port: 80, protocol: "tcp" }),
      rule({ cidr: "10.0.0.0/8", protocol: "udp" }),
      rule({ vmId: "other" }),
      rule({ public: true }, { vmId: "other" }),
      rule({ public: true, cidr: "10.0.0.0/8" }),
    ])
      await expect(c.vms.create(options)).rejects.toBeInstanceOf(CompatibilityError);
    await expect(c.vms.create(rule({ cidr: "300.1.1.1/8" }))).rejects.toBeInstanceOf(
      FirewallRuleValidationError,
    );
    expect(c.created).toEqual([]);
  });

  test("firewallRules reads the VM's network settings back", async () => {
    const c = creating();
    expect((await c.vm.firewallRules()).rules.map((r) => r.destination)).toEqual([
      { public: true },
    ]);
    c.set({ internet: false });
    expect(await c.vm.firewallRules()).toEqual({ rules: [], totalCount: 0 });
    c.set({ internet: true, allow: ["10.0.0.0/8", "192.0.2.1"] });
    expect((await c.vm.firewallRules()).rules.map((r) => r.destination)).toEqual([
      { cidr: "10.0.0.0/8" },
      { cidr: "192.0.2.1/32" },
    ]);
    c.set({ allow: ["example.com"] });
    await expect(c.vm.firewallRules()).rejects.toBeInstanceOf(CompatibilityError);
    c.set({ allow: [], deny: ["10.0.0.1"] });
    await expect(c.vm.firewallRules()).rejects.toBeInstanceOf(CompatibilityError);
  });
});

describe("snapshot catalog", () => {
  test("update renames, relabels and re-times a snapshot", async () => {
    const calls: unknown[] = [];
    const base = {
      id: "00000000-0000-4000-8000-0000000000aa",
      sourceSandboxId: VM,
      name: "old",
      labels: { keep: "1" },
      retentionDays: 7,
      createdAt: "t",
    };
    const runtime = {
      snapshots: {
        get: async () => base,
        update: async (id: string, input: Record<string, unknown>) => {
          calls.push(["update", id, input]);
          return { ...base, ...input };
        },
        extend: async (id: string, days: number) => {
          calls.push(["extend", id, days]);
          return {
            ...base,
            name: "new",
            labels: { keep: "1", "fs.displayName": "N" },
            retentionDays: days,
          };
        },
      },
    } as unknown as Runtime;
    const snapshots = new Freestyle({ client: runtime }).vms.snapshots;
    const updated = await snapshots.update(base.id, {
      slug: "new",
      displayName: "N",
      ttlSeconds: 2 * 86400,
    });
    expect(calls).toEqual([
      ["update", base.id, { name: "new", labels: { keep: "1", "fs.displayName": "N" } }],
      ["extend", base.id, 2],
    ]);
    expect(updated).toMatchObject({ slug: "new", displayName: "N", ttlSeconds: 2 * 86400 });
    await expect(snapshots.update(base.id, { ttlSeconds: 3600 })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    await expect(
      snapshots.update(base.id, { autoDeleteSeconds: 60 } as object),
    ).rejects.toBeInstanceOf(CompatibilityError);
    expect(calls).toHaveLength(2);
  });
});
