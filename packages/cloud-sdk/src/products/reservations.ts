import type { RequestOptions, Transport } from "../transport.js";

/* `runtime.reservations`: book room for a burst. Hold room for N sandboxes of
 * one size for a window of up to 24 hours starting within 14 days; the answer
 * is at once. In the window, creates are never refused `no_capacity` or
 * `quota_exceeded` up to what was booked, and running sandboxes bill as usual; booked room
 * none of your sandboxes use costs a quarter of the memory rate.
 * Standing room (`keep`) is held from now until you cancel it: for a pool that
 * deletes a sandbox after each use and makes another, so a replacement is
 * never refused up to it. Name its snapshots and it is held on the servers
 * holding them, where their forks start; `forKey` keeps it for this key's
 * sandboxes alone. Room none of its sandboxes uses costs a quarter of the
 * memory rate every hour it is held.
 * A decline is not an error: it is a booking with status "declined". Money is
 * integer microdollars in strings (1,000,000 = $1). */

export type BookRoom = {
  /** How many sandboxes of this size to hold room for: 1 to 10000. */
  sandboxes: number;
  /** When the window starts: a Date or an ISO 8601 time, within 14 days. */
  startsAt: Date | string;
  /** When it ends: at most 24 hours after it starts. */
  endsAt: Date | string;
  /** Size of each sandbox. Default 2 vCPU, 4096 MiB memory, 4096 MiB disk. */
  vcpu?: number;
  memoryMiB?: number;
  diskMiB?: number;
  /** Default: the account's default region. */
  region?: string;
};

export type KeepRoom = {
  /** How many sandboxes to hold room for: 1 to 10000. Keep a few more than
   *  the pool runs, for deletes the servers are still finishing. */
  sandboxes: number;
  /** The snapshots its sandboxes fork from (at most 20, one size): the room is
   *  held on the servers holding them, at their size. */
  snapshots?: string[];
  /** Size of each sandbox when no snapshots are named. Default 2 vCPU, 4096
   *  MiB memory, 4096 MiB disk. */
  vcpu?: number;
  memoryMiB?: number;
  diskMiB?: number;
  /** Hold it for this key's sandboxes alone. Default: the whole account's. */
  forKey?: boolean;
  /** Default: the account's default region. */
  region?: string;
};

/** A change to standing room: how many it holds, its snapshots, or both. */
export type ChangeRoom = { sandboxes?: number; snapshots?: string[] };

export type RoomBooking = {
  id: string;
  /** confirmed: the room is held. declined: nothing is held; `reason`,
   *  `message`, `largestSandboxes` and `nearestWindow` say why and what would
   *  fit. cancelled: given back. */
  status: "confirmed" | "declined" | "cancelled";
  /** Standing room: held until cancelled, with no window. */
  standing: boolean;
  /** Standing room's snapshots; empty: any server in the region. */
  snapshots: string[];
  /** Held for the key that booked it alone. */
  forKey: boolean;
  reason: "room" | "share" | "usage" | "credit" | null;
  message: string;
  region: string;
  sandboxes: number;
  vcpu: number;
  memoryMiB: number;
  diskMiB: number;
  startsAt: string;
  /** Null for standing room. */
  endsAt: string | null;
  /** endsAt while confirmed; null for standing room. */
  heldUntil: string | null;
  phase: "upcoming" | "active" | "ended" | null;
  /** The most sandboxes of this size that fit in the window. */
  largestSandboxes: number;
  /** The nearest window the whole booking fits in, or null. */
  nearestWindow: { startsAt: string; endsAt: string } | null;
  /** The most the booking can cost: every booked sandbox running the whole window (any mix of running and unused costs less). */
  estimateMicros: string;
  /** What booked room no sandbox of the account uses costs, in microdollars per GiB-hour of the booked sandboxes' memory, as quoted when booked ("0" before it had a price). */
  unusedRateMicros: string;
  /** The most the booking costs if none of its sandboxes run (nothing if cancelled at least an hour before it starts). */
  unusedMaxMicros: string | null;
  /** The most its unused room costs an hour. */
  unusedPerHourMicros: string;
  /** What its unused room has been charged so far. */
  unusedChargedMicros: string;
  /** Sandboxes in use now, up to what it holds; for standing room, read live. */
  inUse: number;
  peakInUse: number;
  releasedPercent: number;
  createdAt: string;
  cancelledAt: string | null;
};

export type RoomBookingPage = { items: RoomBooking[]; nextCursor: string | null };

const iso = (time: Date | string) => (time instanceof Date ? time.toISOString() : time);

export function reservations(t: Transport) {
  return {
    /** Book room. Check `status`: a decline is a 200, not an error. */
    create: (input: BookRoom, options?: RequestOptions) =>
      t.json<RoomBooking>({
        method: "POST",
        path: "/v1/reservations",
        body: { ...input, startsAt: iso(input.startsAt), endsAt: iso(input.endsAt) },
        ...options,
      }),
    /** Keep standing room until you cancel it. Check `status`: a decline is a
     *  200, not an error. */
    keep: (input: KeepRoom, options?: RequestOptions) =>
      t.json<RoomBooking>({
        method: "POST",
        path: "/v1/reservations",
        body: { ...input, standing: true },
        ...options,
      }),
    /** Change standing room in place. It moves or grows only when all of it
     *  fits now; otherwise it throws `no_capacity` and nothing changes. */
    update: (id: string, change: ChangeRoom, options?: RequestOptions) =>
      t.json<RoomBooking>({
        method: "POST",
        path: `/v1/reservations/${encodeURIComponent(id)}:update`,
        body: change,
        ...options,
      }),
    /** Bookings, newest first; pass `nextCursor` as `cursor` for the next page. */
    list: (query: { limit?: number; cursor?: string } = {}, options?: RequestOptions) =>
      t.json<RoomBookingPage>({ method: "GET", path: "/v1/reservations", query, ...options }),
    get: (id: string, options?: RequestOptions) =>
      t.json<RoomBooking>({
        method: "GET",
        path: `/v1/reservations/${encodeURIComponent(id)}`,
        ...options,
      }),
    /** Give the room back. The booking comes back with status "cancelled". */
    cancel: (id: string, options?: RequestOptions) =>
      t.json<RoomBooking>({
        method: "DELETE",
        path: `/v1/reservations/${encodeURIComponent(id)}`,
        ...options,
      }),
  };
}
