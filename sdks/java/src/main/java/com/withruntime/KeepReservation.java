package com.withruntime;

import java.util.List;

/**
 * Standing room's fields: how many sandboxes, held from now until it is cancelled. Keep a few more
 * than the pool runs, for deletes the servers are still finishing. {@link #snapshots} holds it on
 * the servers holding them, at their size; otherwise the size defaults to a create's: 2 vCPU, 4096
 * MiB memory, 4096 MiB disk, in the default region.
 */
public final class KeepReservation extends Params<KeepReservation> {
  public KeepReservation(int sandboxes) {
    set("standing", true);
    set("sandboxes", sandboxes);
  }

  /** The snapshots its sandboxes fork from: at most 20, all one size. */
  public KeepReservation snapshots(List<String> ids) {
    return set("snapshots", List.copyOf(ids));
  }

  /** Hold it for this key's sandboxes alone. */
  public KeepReservation forKey(boolean forKey) {
    return set("forKey", forKey);
  }

  public KeepReservation vcpu(int vcpu) {
    return set("vcpu", vcpu);
  }

  public KeepReservation memoryMiB(int mib) {
    return set("memoryMiB", mib);
  }

  public KeepReservation diskMiB(int mib) {
    return set("diskMiB", mib);
  }

  public KeepReservation region(String region) {
    return set("region", region);
  }
}
