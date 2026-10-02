import { RuntimeError } from "../errors.js";

/* A rival's sandbox may be asked to live longer than one Runtime lease (an
   hour at most, ARCHITECTURE.md section 10): Vercel's `timeout` over an hour,
   Daytona's `autoStopInterval` over an hour or 0. The drop-ins keep the lease
   reaching toward the time asked for while their sandbox object lives, one
   extension at a time, never past that time. */

/** The most one lease runs ahead of now. */
export const LEASE_MAX_SECONDS = 3600;

/** What the keeper needs of a Runtime sandbox. */
export interface Leased {
  readonly state: string;
  readonly info: { expiresAt: string };
  extend(seconds: number): Promise<unknown>;
  refresh(): Promise<unknown>;
}

/** Whole seconds to add to a lease ending at `expiresAt` (epoch ms) so it
 * reaches toward `until`, at most an hour ahead of `now`; 0 when more than
 * `marginMs` is left or there is nothing to add. */
export function extensionSeconds(
  expiresAt: number,
  until: number,
  now: number,
  marginMs: number,
): number {
  // A lease with no readable end (one that never ends) is left alone.
  if (!Number.isFinite(expiresAt) || expiresAt - now > marginMs) return 0;
  const target = Math.min(until, now + LEASE_MAX_SECONDS * 1000);
  return Math.max(0, Math.floor((target - expiresAt) / 1000));
}

/** Keeps a running sandbox's lease reaching toward `until()`: on `check()`,
 * and once a minute on a timer that never keeps a Node or Bun process alive.
 * When the process ends, the lease runs out within the hour and the sandbox
 * pauses or stops as it was told to at create. A paused or stopped sandbox is
 * left alone; the adapter wakes it on its next call. */
export class LeaseKeeper {
  readonly #sandbox: () => Leased;
  readonly #until: () => number;
  readonly #marginMs: () => number;
  readonly #everyMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: Promise<void> | undefined;
  #ended = false;

  constructor(options: {
    sandbox: () => Leased;
    /** Epoch ms the lease should reach; Infinity for as long as this lives. */
    until: () => number;
    /** Extend only when less than this is left. */
    marginMs: () => number;
    everyMs?: number;
  }) {
    this.#sandbox = options.sandbox;
    this.#until = options.until;
    this.#marginMs = options.marginMs;
    this.#everyMs = options.everyMs ?? 60_000;
  }

  /** Starts the timer when the lease must outlive the next extension. */
  #schedule() {
    if (this.#ended || this.#timer) return;
    const expiresAt = Date.parse(this.#sandbox().info.expiresAt);
    if (!Number.isFinite(expiresAt) || this.#until() <= expiresAt) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.check().catch(() => undefined);
    }, this.#everyMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** Extends the lease if it is near its end and should go further; `now`
   * extends it as far as it may go whatever is left. One call at a time. */
  check(now = false): Promise<void> {
    if (this.#ended) return Promise.resolve();
    this.#pending ??= this.#extend(now).finally(() => {
      this.#pending = undefined;
      this.#schedule();
    });
    return this.#pending;
  }

  async #extend(now: boolean) {
    const sandbox = this.#sandbox();
    if (sandbox.state !== "running") return;
    const seconds = extensionSeconds(
      Date.parse(sandbox.info.expiresAt),
      this.#until(),
      Date.now(),
      now ? Infinity : this.#marginMs(),
    );
    if (seconds < 1) return;
    try {
      await sandbox.extend(seconds);
    } catch (error) {
      // The lease may have ended since the sandbox was last read; the next
      // call through the adapter says what state it is in.
      if (!(error instanceof RuntimeError && error.status === 409)) throw error;
      await sandbox.refresh().catch(() => undefined);
    }
  }

  /** Stops extending: after stop() or delete(). */
  end() {
    this.#ended = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
