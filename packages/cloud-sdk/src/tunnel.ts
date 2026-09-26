import type { Socket } from "node:net";
import { RuntimeError } from "./errors.js";

/* A tunnel into a sandbox: one WebSocket carrying many TCP connections to
   ports on the sandbox's loopback, and SSH logins. The server end and the
   protocol are documented in packages/cloud/src/api/tunnels.ts. */

const OPEN = 0x6f;
const DATA = 0x64;
const END = 0x65;
const CLOSE = 0x63;
const ACK = 0x61;
const LOG = 0x6c;
/** Data this side may send past the sandbox's last report of what it took. */
const WINDOW = 1_048_576;
const CHUNK = 65_536;

function frame(kind: number, stream: number, payload: Uint8Array = new Uint8Array()) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, stream);
  out.set(payload, 5);
  return out;
}

/** One TCP connection (or SSH login) inside a tunnel. Set the handlers before
 * data can arrive, which is as soon as the promise that gave you this resolves. */
export class TunnelStream {
  /** Bytes from the sandbox side. */
  onData?: (data: Uint8Array) => void;
  /** The sandbox side will send nothing more; you may still write. */
  onEnd?: () => void;
  /** The connection is gone. `reason` is "done" after a clean finish. */
  onClose?: (reason: string) => void;
  /** sshd's own error output, for an SSH login that fails. */
  onLog?: (text: string) => void;
  #ended = false;
  #remoteEnded = false;
  #closed = false;
  constructor(
    private readonly tunnel: Tunnel,
    readonly id: number,
  ) {}
  /** Sends bytes. Resolves once they are within the tunnel's window, so
   * awaiting each write is enough backpressure. */
  write(data: Uint8Array): Promise<void> {
    if (this.#ended || this.#closed) return Promise.resolve();
    return this.tunnel.send(this.id, data);
  }
  /** No more bytes from this side; the sandbox side reads end of input. */
  end(): void {
    if (this.#ended || this.#closed) return;
    this.#ended = true;
    void this.tunnel.control(END, this.id);
  }
  /** Drops the connection at once. After both sides have ended, the sandbox
   * finishes it by itself, so a close then would only race the last bytes. */
  close(): void {
    if (this.#closed) return;
    const finishing = this.#ended && this.#remoteEnded;
    this.#closed = true;
    if (!finishing) void this.tunnel.control(CLOSE, this.id);
    this.tunnel.forget(this.id);
  }
  /** @internal */
  receive(kind: number, payload: Uint8Array): void {
    if (kind === DATA) this.onData?.(payload);
    else if (kind === LOG) this.onLog?.(new TextDecoder().decode(payload));
    else if (kind === END) {
      this.#remoteEnded = true;
      this.onEnd?.();
    } else if (kind === CLOSE) this.gone(new TextDecoder().decode(payload) || "closed");
  }
  /** @internal */
  gone(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.tunnel.forget(this.id);
    this.onClose?.(reason);
  }
}

/** A local port forwarded into the sandbox. */
export type PortForward = {
  /** The local address and port that forward (the port the system chose, if you passed 0). */
  readonly host: string;
  readonly localPort: number;
  /** The port inside the sandbox. */
  readonly port: number;
  /** Stops listening and closes every forwarded connection. */
  close(): Promise<void>;
};

export class Tunnel {
  readonly closed: Promise<string>;
  #streams = new Map<number, TunnelStream>();
  #opening = new Map<number, { resolve: (s: TunnelStream) => void; reject: (e: Error) => void }>();
  #next = 1;
  #sent = 0;
  #credited = 0;
  #waiting: (() => void)[] = [];
  #sending: Promise<void> = Promise.resolve();
  #over: string | undefined;
  private constructor(
    private readonly socket: WebSocket,
    closed: Promise<string>,
  ) {
    this.closed = closed;
  }

  /** Waits for the server's ready message. */
  static open(socket: WebSocket): Promise<Tunnel> {
    socket.binaryType = "arraybuffer";
    let settle!: (reason: string) => void;
    const closed = new Promise<string>((resolve) => (settle = resolve));
    return new Promise((resolve, reject) => {
      let tunnel: Tunnel | undefined;
      let failure: RuntimeError | undefined;
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const message = JSON.parse(event.data) as {
            type: string;
            error?: { code: string; message: string; hint?: string; requestId?: string };
          };
          if (message.type === "ready" && !tunnel) {
            tunnel = new Tunnel(socket, closed);
            resolve(tunnel);
          } else if (message.type === "error") {
            failure = new RuntimeError({
              message: message.error?.message ?? "The tunnel failed.",
              code: message.error?.code ?? "tunnel_failed",
              status: 0,
              ...(message.error?.hint ? { hint: message.error.hint } : {}),
              ...(message.error?.requestId ? { requestId: message.error.requestId } : {}),
            });
            if (!tunnel) reject(failure);
          }
        } else tunnel?.receive(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onclose = () => {
        const reason = failure?.message ?? "The tunnel closed.";
        tunnel?.end(reason);
        settle(reason);
        if (!tunnel)
          reject(
            new RuntimeError({
              message:
                "The tunnel could not be opened: check the key, that the sandbox is running, and that your organization has fewer than 16 tunnels open.",
              code: "tunnel_refused",
              status: 0,
            }),
          );
      };
      socket.onerror = () => undefined;
    });
  }

  /** A TCP connection to `port` on the sandbox's loopback (127.0.0.1, then ::1). */
  connect(port: number): Promise<TunnelStream> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      return Promise.reject(
        new RuntimeError({
          message: "port must be 1 to 65535.",
          code: "invalid_request",
          status: 0,
        }),
      );
    return this.#open(`tcp ${port}`, port);
  }

  /** An SSH login as the sandbox's user, authorized by this one public key
   * (the text of an OpenSSH `.pub` file). Speak SSH over the stream. */
  ssh(publicKey: string): Promise<TunnelStream> {
    return this.#open(`ssh ${publicKey.trim()}`);
  }

  /** Listens on a local port and carries each connection to `port` in the
   * sandbox. Node and Bun only. A connection the sandbox cannot open, such as
   * one to a port nothing listens on, is closed at once; `onError` says why. */
  async forward(
    port: number,
    options: {
      localPort?: number;
      host?: string;
      onError?: (error: RuntimeError) => void;
    } = {},
  ): Promise<PortForward> {
    const net = await import("node:net");
    const host = options.host ?? "127.0.0.1";
    const sockets = new Set<Socket>();
    // Half-open: a client that ends its input still gets the answer.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.pause();
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      this.connect(port).then(
        (stream) => {
          stream.onData = (data) => void socket.write(data);
          stream.onEnd = () => void socket.end();
          // "done" follows the last data; ending lets the socket flush it.
          stream.onClose = (reason) => void (reason === "done" ? socket.end() : socket.destroy());
          socket.on("data", (data: Buffer) => {
            socket.pause();
            void stream.write(new Uint8Array(data)).then(() => socket.resume());
          });
          socket.on("end", () => stream.end());
          socket.on("close", () => stream.close());
          socket.resume();
        },
        (error: unknown) => {
          socket.destroy();
          if (error instanceof RuntimeError) options.onError?.(error);
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.localPort ?? port, host, () => resolve());
    });
    const address = server.address();
    return {
      host,
      localPort:
        typeof address === "object" && address ? address.port : (options.localPort ?? port),
      port,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
  }

  /** Closes the tunnel and every connection in it. */
  close(): void {
    this.socket.close(1000);
  }

  #open(target: string, port?: number): Promise<TunnelStream> {
    if (this.#over)
      return Promise.reject(
        new RuntimeError({ message: this.#over, code: "tunnel_closed", status: 0 }),
      );
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#opening.set(id, {
        resolve,
        reject: (error) =>
          reject(
            port !== undefined && error.message === "closed"
              ? new RuntimeError({
                  message: `Nothing is listening on port ${port} in the sandbox.`,
                  code: "port_closed",
                  status: 0,
                  hint: "Start the server with spawn (`runtime sandbox spawn <id> -- <command>`, sbx.spawn()), which keeps it running: a process started by exec ends with its command. Let it listen on 127.0.0.1, ::1 or every address.",
                })
              : error.message === "reserved"
                ? new RuntimeError({
                    message: `Port ${port} is the sandbox's own outbound proxy, which a tunnel does not reach.`,
                    code: "port_reserved",
                    status: 0,
                  })
                : error.message === "no-sshd"
                  ? new RuntimeError({
                      message: "The sandbox has no OpenSSH server (sshd).",
                      code: "sshd_missing",
                      status: 0,
                      hint: "Install it once: sudo apt-get install -y openssh-server",
                    })
                  : new RuntimeError({
                      message: `The sandbox refused the connection (${error.message}).`,
                      code: "tunnel_refused",
                      status: 0,
                    }),
          ),
      });
      this.#write(frame(OPEN, id, new TextEncoder().encode(target)));
    });
  }

  /** @internal Data for one stream, within the window. */
  send(id: number, data: Uint8Array): Promise<void> {
    const sending = this.#sending.then(async () => {
      for (let at = 0; at < data.length && !this.#over; at += CHUNK) {
        const piece = data.subarray(at, at + CHUNK);
        while (this.#sent + piece.length - this.#credited > WINDOW && !this.#over)
          await new Promise<void>((resolve) => this.#waiting.push(resolve));
        if (this.#over) return;
        this.#sent += piece.length;
        this.#write(frame(DATA, id, piece));
      }
    });
    this.#sending = sending.catch(() => undefined);
    return sending;
  }

  /** @internal End or close, in order behind any data still waiting. */
  control(kind: number, id: number): Promise<void> {
    const sending = this.#sending.then(() => this.#write(frame(kind, id)));
    this.#sending = sending.catch(() => undefined);
    return sending;
  }

  /** @internal */
  forget(id: number): void {
    this.#streams.delete(id);
  }

  #write(bytes: Uint8Array) {
    if (!this.#over && this.socket.readyState === 1) this.socket.send(bytes);
  }

  private receive(message: Uint8Array) {
    if (message.length < 5) return;
    const kind = message[0]!;
    const view = new DataView(message.buffer, message.byteOffset, message.length);
    const id = view.getUint32(1);
    const payload = message.subarray(5);
    if (kind === ACK) {
      this.#credited = Math.max(this.#credited, Number(view.getBigUint64(5)));
      for (const wake of this.#waiting.splice(0)) wake();
      return;
    }
    const opening = this.#opening.get(id);
    if (opening) {
      this.#opening.delete(id);
      if (kind === OPEN) {
        const stream = new TunnelStream(this, id);
        this.#streams.set(id, stream);
        opening.resolve(stream);
      } else opening.reject(new Error(new TextDecoder().decode(payload) || "closed"));
      return;
    }
    this.#streams.get(id)?.receive(kind, payload);
  }

  private end(reason: string) {
    this.#over = reason;
    for (const wake of this.#waiting.splice(0)) wake();
    for (const { reject } of this.#opening.values()) reject(new Error(reason));
    this.#opening.clear();
    for (const stream of [...this.#streams.values()]) stream.gone(reason);
  }
}
