/* A terminal's or tunnel's WebSocket that outlives a restart of the API
   behind it. The API hands each open socket to the instance that serves next
   (packages/cloud/src/api/tunnels.ts, "Hand-off"):

   1. it sends {"type":"restart"}; this side stops sending, buffers what the
      caller writes, and answers {"type":"restart"};
   2. it sends {"type":"resume","token":...,"replay":...} and closes with
      1012 (Service Restart);
   3. this side opens the socket again with ?resume=<token>, sends
      {"type":"replay","data":...} first when there was input the API had not
      yet written, then what it buffered.

   The terminal's output and the tunnel's streams continue from the exact
   byte they stopped at; nothing is lost or repeated, and the caller sees no
   close. A socket closed with anything else, or without a token, closes as
   before. */

/** RFC 6455 close code 1012, Service Restart. */
export const SERVICE_RESTART = 1012;
/** How long reconnecting may take before the socket is reported closed:
 * within the token's 30 s, after which the API ends the process. */
export const RESUME_MS = 25_000;

type Message = { data: string | ArrayBuffer };
type Closed = { code: number; reason: string };

/** The part of WebSocket that Terminal and Tunnel use. */
export class ResumableSocket {
  binaryType = "arraybuffer";
  onmessage: ((event: Message) => void) | null = null;
  onclose: ((event: Closed) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  #socket: WebSocket;
  #open: (resume?: string) => Promise<WebSocket>;
  #paused = false;
  #outbox: (string | Uint8Array)[] = [];
  #token: string | undefined;
  #replay: string | undefined;
  #closed = false;
  /** Times this socket resumed, and of those how many replayed input the
   * API had not yet written, for tests and diagnostics. */
  resumes = 0;
  replays = 0;

  private constructor(socket: WebSocket, open: (resume?: string) => Promise<WebSocket>) {
    this.#socket = socket;
    this.#open = open;
    this.#attach(socket);
  }

  /** `open` opens the API's WebSocket, with `resume` once there is a token. */
  static async open(open: (resume?: string) => Promise<WebSocket>): Promise<ResumableSocket> {
    return new ResumableSocket(await open(), open);
  }

  /** OPEN (1) while it is open or resuming, CLOSED (3) once it closed. */
  get readyState(): number {
    return this.#closed ? 3 : this.#socket.readyState === 0 ? 0 : 1;
  }

  send(data: string | Uint8Array): void {
    if (this.#closed) return;
    if (this.#paused) this.#outbox.push(data);
    else this.#socket.send(data as Uint8Array<ArrayBuffer>);
  }

  close(code = 1000, reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outbox = [];
    try {
      this.#socket.close(code, reason);
    } catch {
      // Closed already.
    }
    // A socket closed while resuming has no close event of its own to wait for.
    if (this.#paused) this.onclose?.({ code, reason: reason ?? "" });
  }

  #attach(socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event: MessageEvent) => {
      if (socket !== this.#socket) return;
      if (typeof event.data === "string") {
        let message: { type?: unknown; token?: unknown; replay?: unknown } | undefined;
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          message = undefined;
        }
        if (message?.type === "restart") {
          this.#paused = true;
          socket.send(JSON.stringify({ type: "restart" }));
          return;
        }
        if (message?.type === "resume" && typeof message.token === "string") {
          this.#token = message.token;
          this.#replay = typeof message.replay === "string" ? message.replay : undefined;
          return;
        }
      }
      this.onmessage?.({ data: event.data as string | ArrayBuffer });
    };
    socket.onclose = (event: CloseEvent) => {
      if (socket !== this.#socket || this.#closed) return;
      if (event.code === SERVICE_RESTART && this.#token) return void this.#resume();
      this.#closed = true;
      this.onclose?.({ code: event.code, reason: event.reason });
    };
    socket.onerror = (event: Event) => {
      if (socket === this.#socket) this.onerror?.(event);
    };
  }

  async #resume() {
    const token = this.#token!;
    const replay = this.#replay;
    this.#token = this.#replay = undefined;
    const deadline = Date.now() + RESUME_MS;
    let failure: Closed = { code: 1006, reason: "The connection could not be resumed." };
    for (let wait = 50; Date.now() < deadline && !this.#closed; wait = Math.min(wait * 2, 1000)) {
      const answer = await this.#reopen(token, replay);
      if ("socket" in answer) return;
      if (answer.final) {
        // The API refused this resume for good (the sandbox stopped, say):
        // its error is the caller's, as on any socket.
        this.onmessage?.({ data: answer.final });
        failure = answer.closed;
        break;
      }
      failure = answer.closed;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (this.#closed) return;
    this.#closed = true;
    this.#outbox = [];
    this.onclose?.(failure);
  }

  #resumed(socket: WebSocket, replay: string | undefined) {
    this.#socket = socket;
    this.#attach(socket);
    this.resumes++;
    if (replay) {
      this.replays++;
      socket.send(JSON.stringify({ type: "replay", data: replay }));
    }
    const outbox = this.#outbox;
    this.#outbox = [];
    this.#paused = false;
    for (const data of outbox) socket.send(data as Uint8Array<ArrayBuffer>);
  }

  /** One attempt: the socket, in use once the API said it resumed, or how it
   * ended. */
  async #reopen(
    token: string,
    replay: string | undefined,
  ): Promise<{ socket: WebSocket } | { closed: Closed; final?: string }> {
    let socket: WebSocket;
    try {
      socket = await this.#open(token);
    } catch (error) {
      return {
        closed: {
          code: 1006,
          reason: error instanceof Error ? error.message : "The connection could not be resumed.",
        },
      };
    }
    socket.binaryType = "arraybuffer";
    return new Promise((resolve) => {
      let final: string | undefined;
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let message: { type?: unknown; resumed?: unknown } | undefined;
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          return;
        }
        if (message?.type === "ready" && message.resumed === true) {
          // Taken over here, before the next frame: output may follow in the
          // same read, delivered before any promise settles.
          if (this.#closed) socket.close(1000);
          else this.#resumed(socket, replay);
          resolve({ socket });
        } else if (message?.type === "error") final = event.data;
      };
      socket.onclose = (event: CloseEvent) =>
        resolve({
          closed: { code: event.code, reason: event.reason },
          ...(final ? { final } : {}),
        });
      socket.onerror = () => undefined;
    });
  }
}
