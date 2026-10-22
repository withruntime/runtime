package com.withruntime;

/**
 * {@code runtime.reservations()}: book room for a burst. Holds room for N sandboxes of one size for
 * a window of up to 24 hours starting within 14 days, and answers at once. In the window, creates
 * are never refused no_capacity or quota_exceeded up to what was booked; running sandboxes bill as usual and booked
 * room none of them use costs a quarter of the memory rate. A decline is a booking with status "declined", not an exception.
 * Standing room ({@link #keep}) is held until it is cancelled, on the servers holding its snapshots.
 */
public final class Reservations {
  private final Transport t;

  Reservations(Transport transport) {
    this.t = transport;
  }

  /** Books room. Check {@link RoomBooking#status()}: a decline is not an error. */
  public RoomBooking create(CreateReservation options) {
    return new RoomBooking(
        t.object(new Transport.Call("POST", "/v1/reservations").body(options.toMap()).key(options.idempotencyKey)));
  }

  /**
   * Keeps standing room from now until it is cancelled, for a pool that deletes a sandbox after each
   * use and makes another. Check {@link RoomBooking#status()}: a decline is not an error.
   */
  public RoomBooking keep(KeepReservation options) {
    return new RoomBooking(
        t.object(new Transport.Call("POST", "/v1/reservations").body(options.toMap()).key(options.idempotencyKey)));
  }

  /**
   * Changes standing room in place. It moves or grows only when all of it fits now; otherwise it
   * throws a no_capacity error and nothing changes.
   */
  public RoomBooking update(String id, UpdateReservation change) {
    return new RoomBooking(
        t.object(
            new Transport.Call("POST", "/v1/reservations/" + Transport.segment(id) + ":update")
                .body(change.toMap())
                .key(change.idempotencyKey)));
  }

  /** The first page of bookings, newest first; {@code limit} and {@code cursor} may be null. */
  public Page<RoomBooking> list(Integer limit, String cursor) {
    return Page.read(t, call(limit, cursor), "items", RoomBooking::new, next -> call(limit, next));
  }

  private static Transport.Call call(Integer limit, String cursor) {
    return new Transport.Call("GET", "/v1/reservations").query("limit", limit).query("cursor", cursor);
  }

  public RoomBooking get(String id) {
    return new RoomBooking(t.object(new Transport.Call("GET", "/v1/reservations/" + Transport.segment(id))));
  }

  /** Gives the room back. The booking comes back with status "cancelled". */
  public RoomBooking cancel(String id) {
    return new RoomBooking(t.object(new Transport.Call("DELETE", "/v1/reservations/" + Transport.segment(id))));
  }
}
