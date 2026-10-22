package com.withruntime;

import java.time.Instant;

/**
 * A booking's fields: how many sandboxes, and the window (at most 24 hours long, starting now or
 * within 14 days). The size defaults to a create's: 2 vCPU, 4096 MiB memory, 4096 MiB disk, in the
 * default region.
 */
public final class CreateReservation extends Params<CreateReservation> {
  public CreateReservation(int sandboxes, Instant startsAt, Instant endsAt) {
    this(sandboxes, startsAt.toString(), endsAt.toString());
  }

  /** The window as ISO 8601 times with a zone. */
  public CreateReservation(int sandboxes, String startsAt, String endsAt) {
    set("sandboxes", sandboxes);
    set("startsAt", startsAt);
    set("endsAt", endsAt);
  }

  public CreateReservation vcpu(int vcpu) {
    return set("vcpu", vcpu);
  }

  public CreateReservation memoryMiB(int mib) {
    return set("memoryMiB", mib);
  }

  public CreateReservation diskMiB(int mib) {
    return set("diskMiB", mib);
  }

  public CreateReservation region(String region) {
    return set("region", region);
  }
}
