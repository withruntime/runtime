# Book room for a burst

Batch work comes in bursts: a run of evals, RL rollouts or browser sessions
wants hundreds of sandboxes at nine tonight, not a steady few. Book the room
ahead and you are told at once whether you have it. Inside the window your
creates are never refused `no_capacity` or `quota_exceeded` up to what you
booked, and you create sandboxes as usual: there is nothing to name.

- **Up to 10,000 sandboxes** of one size, in one region.
- **A window of up to 24 hours**, starting now or within 14 days.
- **Confirmed or declined at once.** A decline says why, the most sandboxes
  that window can take, and the nearest window that takes them all.
- **Sandboxes you run bill as usual**, per second. Booked room none of them
  uses costs a quarter of the memory rate, {{booked-unused-rate}} per GiB-hour,
  with no CPU charge; cancel at least an hour before the start and it costs
  nothing. See [What it costs](#what-it-costs).

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const booking = await runtime.reservations.create({
  sandboxes: 300,
  vcpu: 1,
  memoryMiB: 2048,
  startsAt: "2026-10-18T03:00:00Z",
  endsAt: "2026-10-18T05:00:00Z",
});
if (booking.status === "declined") {
  console.log(booking.message, booking.largestSandboxes, booking.nearestWindow);
}
```

```python check
from withruntime import Runtime

runtime = Runtime()
booking = runtime.reservations.create(
    sandboxes=300, vcpu=1, memory_mib=2048,
    starts_at="2026-10-18T03:00:00Z", ends_at="2026-10-18T05:00:00Z",
)
```

```bash no-run
npx withruntime reservations book --sandboxes 300 --vcpu 1 --memory 2048 --from 21:00 --to 23:00
```

`--from` and `--to` take a time in your own time zone (today, or tomorrow
once it has passed), an ISO time, or `now`. The API is
`POST /v1/reservations`; MCP's tool is `runtime_reservations`.

## Standing room for a pool

A pool keeps sandboxes ready and replaces each one after use: a warm pool of
CI machines, a fleet of agents forked from one snapshot. Its replacements are
creates like any other, so on a busy server one can be refused. Standing room
is held from now until you cancel it, and a replacement inside it is never
refused for room or limits.

- **Name the snapshots** your pool forks from, and the room is held on the
  servers holding them, where their forks start, at their size.
- **`forKey`** keeps it for the sandboxes of the key that booked it, so the
  rest of your account's work never takes the pool's room.
- **Keep a few more than the pool runs.** A deleted sandbox gives its room
  back once its server has stopped it, a moment later; the spare room lets
  the replacement start at once.
- **`inUse`** says how many of its sandboxes run now, read live.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const pool = await runtime.reservations.keep({
  sandboxes: 40,
  snapshots: ["3f6a0d2e-9b1c-4f7a-8e5d-2c4b6a8d0e1f"],
  forKey: true,
});
console.log(pool.status, pool.inUse, pool.unusedPerHourMicros);
// A new snapshot: the room moves to its servers when it all fits there.
await runtime.reservations.update(pool.id, { snapshots: ["7b2e4c6a-1d3f-4a5b-9c8d-0e2f4a6b8c1d"] });
```

```python check
from withruntime import Runtime

runtime = Runtime()
pool = runtime.reservations.keep(sandboxes=40, snapshots=["3f6a0d2e-9b1c-4f7a-8e5d-2c4b6a8d0e1f"], for_key=True)
```

```bash no-run
npx withruntime reservations keep --sandboxes 40 --snapshot 3f6a0d2e-9b1c-4f7a-8e5d-2c4b6a8d0e1f --for-key
```

The API is `POST /v1/reservations` with `standing: true` and no `startsAt` or
`endsAt`. `POST /v1/reservations/{id}:update` changes how many it holds or
its snapshots: the room moves, or grows, only when all of it fits now;
otherwise the answer is `503 no_capacity` with what fits, and nothing
changes. Snapshots of one standing booking are all one size.

Room none of its sandboxes uses costs what a booking's does, a quarter of the
memory rate, **{{booked-unused-rate}} per GiB-hour**, charged every hour it is
held; `unusedPerHourMicros` is the most that comes to in an hour. Cancel it
and the charge stops at once. It is held while it is paid for: once your
balance can't cover a day of it unused, or your account is held back, it is
let go and the room goes back to everyone; sandboxes you run keep running.
Standing room is decided as a booking is,
against what is free on its servers now and the margin of every hour of the
day.

## What a booking holds

The size you book is the size you will create: `vcpu`, `memoryMiB` and
`diskMiB` of each sandbox (by default 2 vCPU, 4096 MiB and
4096 MiB, a create's defaults). Room is held for that many sandboxes of that
size on the region's servers.

In the window:

- Your account's limits on sandboxes at once, their vCPUs, memory and disk
  rise by what you booked. The [Limits page](https://withruntime.com/account/limits)
  and `GET /v1/limits` show the raised numbers.
- The room is kept from every other account, and your creates go there
  first. Every sandbox you run in the region counts toward it.
- Past the window's half, room you are not using goes back to everyone in
  quarters. The sandboxes you are running are always kept.

At the end nothing is stopped: sandboxes still running keep running, and new
creates meet your usual limits again. Cancel a booking you no longer need
(`runtime.reservations.cancel(id)`, `DELETE /v1/reservations/{id}`): its room
goes back at once and what runs keeps running.

## What it costs

Sandboxes you run in the window bill as they always do, per second, at the
usual rates. Room you booked that none of your sandboxes uses costs a quarter
of the memory rate: **{{booked-unused-rate}} per GiB-hour** of the booked
sandboxes' memory, with no CPU charge.

- It is measured each minute the window is live: the sandboxes the booking
  holds room for, less the sandboxes you run in the region.
- Past the window's half, unused room goes back to everyone in quarters, and
  room that has gone back costs nothing.
- Cancel at least an hour before the start and it costs nothing. Cancel later
  and the unused room is charged until an hour after the start, or until you
  cancel if that is later.
- It is charged from your balance every hour of the window and when it ends.

The confirmation says the rate (`unusedRateMicros`, per GiB-hour) and the
most the booking costs if none of its sandboxes run (`unusedMaxMicros`), and
`unusedChargedMicros` shows what it has cost so far. For 300 sandboxes of
2 GiB booked for 2 hours:

| What runs                        | Booked room charged |
| -------------------------------- | ------------------- |
| All 300, the whole window        | Nothing             |
| 150 of them, the whole window    | $0.77               |
| None                             | $1.83               |
| Nothing; cancelled 2 hours ahead | Nothing             |

If none run, it costs at most {{booked-unused-example}}: every booked sandbox's
memory unused the whole window (300 × 2 GiB × 2 hours × {{booked-unused-rate}}).
Room going back past the half brings it to $1.83.

## When a booking is declined

A declined booking is an answer, not an error: `status` is `declined` and
`reason` says why.

| `reason` | What it means                                                                                                                               | What to do                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `room`   | That window has no more room without taking what other customers need                                                                       | Book `largestSandboxes`, or the `nearestWindow` it names                                     |
| `share`  | One account books at most a quarter of the region's spare room at once                                                                      | Book `largestSandboxes`, or split the burst over windows                                     |
| `usage`  | Three of your bookings in the last 30 days used under a fifth of what they held, so bookings are smaller for now                            | Book what you will run                                                                       |
| `credit` | The balance doesn't cover `estimateMicros` beside your other bookings' (with auto top-up on, what you paid more than a week ago counts too) | Book `largestSandboxes`, or add credit in [Billing](https://withruntime.com/account/billing) |

An account whose sandbox limits Runtime set lower, a pilot, or an account
held back by a dispute or an abuse report can't book (`403`): write to
support@withruntime.com. An account asks at most 20 times in ten minutes
(`429`).

`estimateMicros` is the most the booking can cost: every sandbox running the
whole window (any mix of running and unused costs less). It is not charged.
Your balance covers it, beside the estimates of your other bookings not yet
ended. With auto top-up on, what you have paid and kept for more than a week
counts toward it too, so a new card alone doesn't raise your limits.

## How room is decided

Each region keeps a margin for everyone else: the most its customers ran
outside bookings in the same hours over the last two weeks, plus a fifth. A
booking never takes the margin, and never stops, moves or pauses anyone's
sandbox. That is why a booking is a promise we can keep, and why a busy hour
may decline one that a quiet hour confirms.

## Reading bookings

`runtime.reservations.list()` (`GET /v1/reservations`) lists your bookings and
declines, newest first. Each has `phase` (`upcoming`, `active` or `ended`),
`inUse` (sandboxes you run in the region now, up to the booked number) and
`peakInUse`. The console's [Limits page](https://withruntime.com/account/limits)
shows your active and upcoming bookings.
