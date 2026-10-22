package com.withruntime;

import java.util.List;

/** A change to standing room: how many it holds, its snapshots, or both. */
public final class UpdateReservation extends Params<UpdateReservation> {
  public UpdateReservation() {}

  public UpdateReservation sandboxes(int sandboxes) {
    return set("sandboxes", sandboxes);
  }

  /** New snapshots of the same size: the room moves to the servers holding them. */
  public UpdateReservation snapshots(List<String> ids) {
    return set("snapshots", List.copyOf(ids));
  }
}
