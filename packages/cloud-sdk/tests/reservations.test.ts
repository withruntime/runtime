import { expect, test } from "bun:test";
import { bookingTime, run } from "../src/cli";
import { Runtime } from "../src/client";

/* runtime.reservations and `runtime reservations` against a stub API. The
   route is tested over Postgres in packages/cloud. */

const CONFIRMED = {
  id: "5b0f4c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b",
  status: "confirmed",
  standing: false,
  snapshots: [],
  forKey: false,
  reason: null,
  message: "Room is held.",
  region: "us-west",
  sandboxes: 300,
  vcpu: 2,
  memoryMiB: 4096,
  diskMiB: 4096,
  startsAt: "2026-10-17T21:00:00.000Z",
  endsAt: "2026-10-17T23:00:00.000Z",
  heldUntil: "2026-10-17T23:00:00.000Z",
  phase: "upcoming",
  largestSandboxes: 300,
  nearestWindow: null,
  estimateMicros: "12000000",
  unusedRateMicros: "1875",
  unusedMaxMicros: "4500000",
  unusedPerHourMicros: "2250000",
  unusedChargedMicros: "0",
  inUse: 0,
  peakInUse: 0,
  releasedPercent: 0,
  createdAt: "2026-10-17T18:00:00.000Z",
  cancelledAt: null,
};
const DECLINED = {
  ...CONFIRMED,
  status: "declined",
  reason: "room",
  message: "Only 120 sandboxes of that size fit in that window.",
  heldUntil: null,
  phase: null,
  largestSandboxes: 120,
  nearestWindow: { startsAt: "2026-10-18T02:00:00.000Z", endsAt: "2026-10-18T04:00:00.000Z" },
};

const SNAPSHOT = "9c1d2e3f-4a5b-4e5f-8a9b-0c1d2e3f4a5b";
const STANDING = {
  ...CONFIRMED,
  standing: true,
  snapshots: [SNAPSHOT],
  forKey: true,
  sandboxes: 40,
  memoryMiB: 1024,
  endsAt: null,
  heldUntil: null,
  phase: "active",
  unusedMaxMicros: null,
  unusedPerHourMicros: "75000",
  inUse: 36,
};

type Seen = {
  method: string;
  path: string;
  query: string;
  body?: Record<string, unknown>;
  key: string | null;
};
async function withStub(answer: (seen: Seen) => unknown, work: (seen: Seen[]) => Promise<void>) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const call: Seen = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}),
      key: request.headers.get("idempotency-key"),
    };
    seen.push(call);
    return Response.json(answer(call));
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
function output(json = false) {
  const lines: string[] = [];
  return {
    lines,
    out: { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}
const runtime = () => new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });

test("reservations.create() posts ISO times with an idempotency key, and a decline is an answer, not an error", async () => {
  await withStub(
    () => DECLINED,
    async (seen) => {
      const booking = await runtime().reservations.create({
        sandboxes: 300,
        startsAt: new Date("2026-10-17T21:00:00Z"),
        endsAt: "2026-10-17T23:00:00Z",
        vcpu: 2,
      });
      expect(booking.status).toBe("declined");
      expect(seen[0]).toMatchObject({
        method: "POST",
        path: "/v1/reservations",
        body: {
          sandboxes: 300,
          startsAt: "2026-10-17T21:00:00.000Z",
          endsAt: "2026-10-17T23:00:00Z",
          vcpu: 2,
        },
      });
      expect(seen[0]!.key).toBeTruthy();
    },
  );
});

test("reservations list, get and cancel use their routes", async () => {
  await withStub(
    (call) =>
      call.path === "/v1/reservations" ? { items: [CONFIRMED], nextCursor: "c2" } : CONFIRMED,
    async (seen) => {
      const api = runtime().reservations;
      expect((await api.list({ limit: 5, cursor: "c1" })).nextCursor).toBe("c2");
      await api.get(CONFIRMED.id);
      await api.cancel(CONFIRMED.id);
      expect(seen.map((c) => `${c.method} ${c.path}${c.query}`)).toEqual([
        "GET /v1/reservations?limit=5&cursor=c1",
        `GET /v1/reservations/${CONFIRMED.id}`,
        `DELETE /v1/reservations/${CONFIRMED.id}`,
      ]);
    },
  );
});

test("bookingTime reads HH:MM on the local clock: today, tomorrow once past, and an end before the start is the next day", () => {
  const now = new Date(2026, 9, 17, 18, 30).getTime();
  const at = (d: Date) => [d.getDate(), d.getHours(), d.getMinutes()];
  const from = bookingTime("from", "21:00", now);
  expect(at(from)).toEqual([17, 21, 0]);
  expect(at(bookingTime("from", "09:15", now))).toEqual([18, 9, 15]);
  expect(at(bookingTime("to", "23:00", now, from.getTime()))).toEqual([17, 23, 0]);
  expect(at(bookingTime("to", "02:00", now, from.getTime()))).toEqual([18, 2, 0]);
  expect(bookingTime("from", "now", now).getTime()).toBe(now);
  expect(bookingTime("from", "2026-10-18T01:00:00Z", now).toISOString()).toBe(
    "2026-10-18T01:00:00.000Z",
  );
  expect(() => bookingTime("from", "25:00", now)).toThrow(/time of day/);
  expect(() => bookingTime("from", "soon", now)).toThrow(/--from takes/);
});

test("`runtime reservations book` sends the window and says it is booked", async () => {
  await withStub(
    () => CONFIRMED,
    async (seen) => {
      const { lines, out } = output();
      expect(
        await run(
          [
            "reservations",
            "book",
            "--sandboxes",
            "300",
            "--from",
            "21:00",
            "--to",
            "23:00",
            "--region",
            "us-west",
          ],
          env,
          out,
        ),
      ).toBe(0);
      const body = seen[0]!.body!;
      expect(body.sandboxes).toBe(300);
      expect(body.region).toBe("us-west");
      const start = new Date(String(body.startsAt));
      const end = new Date(String(body.endsAt));
      expect([start.getHours(), start.getMinutes(), end.getHours()]).toEqual([21, 0, 23]);
      expect(end.getTime() - start.getTime()).toBe(2 * 3_600_000);
      expect(lines.join("\n")).toMatch(
        /^Booked 300 sandboxes \(2 vCPU, 4096 MiB\) in us-west from .* to .*\. Creates in the window are never refused for room or limits up to that\. Room none of your sandboxes uses costs \$0\.001875 per GiB-hour: at most \$4\.50 if none run, nothing if cancelled at least an hour before the start\. id 5b0f4c1e/,
      );
    },
  );
});

test("a declined booking prints the message and what fits, exits 1, and --json prints the booking", async () => {
  await withStub(
    () => DECLINED,
    async () => {
      const { lines, out } = output();
      const book = ["reservations", "book", "--sandboxes", "300", "--from", "now", "--to", "23:00"];
      expect(await run(book, env, out)).toBe(1);
      const text = lines.join("\n");
      expect(text).toMatch(/Only 120 sandboxes of that size fit/);
      expect(text).toMatch(/Largest that fits: 120/);
      expect(text).toMatch(/Nearest window for all 300/);
      const json = output(true);
      expect(await run([...book, "--json"], env, json.out)).toBe(1);
      expect(JSON.parse(json.lines[0]!)).toEqual(DECLINED);
    },
  );
});

test("`runtime reservations ls`, get and cancel", async () => {
  await withStub(
    (call) =>
      call.path === "/v1/reservations" ? { items: [CONFIRMED], nextCursor: null } : CONFIRMED,
    async (seen) => {
      const listed = output();
      expect(await run(["reservations", "ls"], env, listed.out)).toBe(0);
      expect(listed.lines.join("\n")).toMatch(/5b0f4c1e.*upcoming.*300/);
      const got = output();
      expect(await run(["reservations", "get", CONFIRMED.id], env, got.out)).toBe(0);
      expect(got.lines.join("\n")).toMatch(/In use now: 0/);
      expect(await run(["reservations", "cancel", CONFIRMED.id], env, output().out)).toBe(0);
      expect(seen.at(-1)).toMatchObject({
        method: "DELETE",
        path: `/v1/reservations/${CONFIRMED.id}`,
      });
    },
  );
});

test("reservations.keep() books standing room, and update() changes it in place", async () => {
  await withStub(
    () => STANDING,
    async (seen) => {
      const api = runtime().reservations;
      const kept = await api.keep({ sandboxes: 40, snapshots: [SNAPSHOT], forKey: true });
      expect(kept.endsAt).toBeNull();
      await api.update(STANDING.id, { snapshots: [SNAPSHOT] });
      expect(seen[0]).toMatchObject({
        method: "POST",
        path: "/v1/reservations",
        body: { standing: true, sandboxes: 40, snapshots: [SNAPSHOT], forKey: true },
      });
      expect(seen[0]!.key).toBeTruthy();
      expect(seen[1]).toMatchObject({
        method: "POST",
        path: `/v1/reservations/${STANDING.id}:update`,
        body: { snapshots: [SNAPSHOT] },
      });
    },
  );
});

test("`runtime reservations keep` holds standing room and says how much is in use; change moves it", async () => {
  await withStub(
    () => STANDING,
    async (seen) => {
      const { lines, out } = output();
      const keep = [
        "reservations",
        "keep",
        "--sandboxes",
        "40",
        "--snapshot",
        SNAPSHOT,
        "--for-key",
      ];
      expect(await run(keep, env, out)).toBe(0);
      expect(seen[0]!.body).toEqual({
        sandboxes: 40,
        snapshots: [SNAPSHOT],
        forKey: true,
        standing: true,
      });
      expect(lines.join("\n")).toMatch(
        /^Holding 40 sandboxes \(2 vCPU, 1024 MiB\) in us-west on the servers holding its snapshots for this key until you cancel; 36 in use\. .* at most \$0\.08 an hour if none run\. id 5b0f4c1e/,
      );
      expect(
        await run(["reservations", "change", STANDING.id, "--sandboxes", "44"], env, output().out),
      ).toBe(0);
      expect(seen[1]).toMatchObject({
        path: `/v1/reservations/${STANDING.id}:update`,
        body: { sandboxes: 44 },
      });
      const listed = output();
      await withStub(
        () => ({ items: [STANDING], nextCursor: null }),
        async () => {
          expect(await run(["reservations", "ls"], env, listed.out)).toBe(0);
        },
      );
      expect(listed.lines.join("\n")).toMatch(/until cancelled/);
      await expect(run(["reservations", "change", STANDING.id], env, output().out)).rejects.toThrow(
        /Usage/,
      );
    },
  );
});
