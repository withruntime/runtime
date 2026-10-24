import { afterAll, afterEach, beforeAll, beforeEach, jest } from "bun:test";
import { access } from "node:fs/promises";

/* Tests on bun's fake clock (setTimeout, setInterval, AbortSignal.timeout,
   Bun.sleep, Date.now, performance.now), which jumps to the next timer
   whenever the work in hand has gone quiet: a poll's 250 ms pause, a retry's
   back-off and a deadline cost nothing, and still come in the order their
   times say. Quiet is three turns of the event loop with nothing done but a
   timer pending, so a fake server's answer, which needs a turn or two, lands
   before a deadline it beats on the wall clock.

   A turn is a file system call, not setImmediate: with fake timers pending,
   bun's event loop slept until a fake timer's real time before it ran the
   next immediate, so a test with a 1000 ms poll waited 0.9 s of real time
   for nothing (23 October 2026). The thread pool's answer wakes it.

   Work on its way outside the event loop holds the clock still until it
   ends: a fetch until its answer starts (to a local server, whose answer is
   real I/O: jumped past meanwhile, its 20 s deadline fired before a loopback
   answer came), and a SHA-256 on the thread pool (a 4 MB file's digest
   outlasted three turns, and the call's deadline fired first).

   `onFakeClock()`, called once at a file's top, puts every test of the file
   on it; `onFakeClockFor(work)` one test's work. */

const turn = () =>
  Promise.all([access("/"), new Promise<void>((resolve) => setImmediate(resolve))]);
let inflight = 0;
async function counted<T>(work: () => Promise<T>): Promise<T> {
  inflight++;
  try {
    return await work();
  } finally {
    inflight--;
  }
}
const real = { fetch: globalThis.fetch, digest: crypto.subtle.digest.bind(crypto.subtle) };
const fetchCounted = Object.assign(
  (...args: Parameters<typeof fetch>) => counted(() => real.fetch(...args)),
  real.fetch,
);
const digestCounted: typeof crypto.subtle.digest = (...args) => counted(() => real.digest(...args));

function fake() {
  jest.useFakeTimers();
  globalThis.fetch = fetchCounted;
  crypto.subtle.digest = digestCounted;
}

function realClock() {
  globalThis.fetch = real.fetch;
  // The SubtleCrypto prototype's own again.
  delete (crypto.subtle as Partial<SubtleCrypto>).digest;
  jest.useRealTimers();
}

/** Moves the clock while `running()` says so. */
async function pump(running: () => boolean) {
  while (running()) {
    for (let i = 0; i < 3 && running(); i++) await turn();
    if (running() && inflight === 0 && jest.getTimerCount() > 0) jest.advanceTimersToNextTimer();
  }
}

export function onFakeClock(): void {
  // Each test's own pump: one left from the test before stops at its next turn.
  let test = 0;
  beforeAll(fake);
  afterAll(realClock);
  beforeEach(() => {
    const mine = ++test;
    void pump(() => mine === test);
  });
  afterEach(() => {
    test++;
  });
}

export async function onFakeClockFor<T>(work: () => Promise<T>): Promise<T> {
  fake();
  let done = false;
  const pumped = pump(() => !done);
  try {
    return await work();
  } finally {
    done = true;
    await pumped;
    realClock();
  }
}
