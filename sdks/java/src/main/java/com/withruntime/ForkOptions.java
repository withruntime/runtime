package com.withruntime;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A fork's fields, every one optional. */
public final class ForkOptions extends Params<ForkOptions> {
  public ForkOptions() {}

  /** How many copies, 1 to 10. Default 1. */
  public ForkOptions count(int count) {
    return set("count", count);
  }

  public ForkOptions name(String name) {
    return set("name", name);
  }

  @SuppressWarnings("unchecked")
  public ForkOptions label(String key, String value) {
    ((Map<String, String>) body.computeIfAbsent("labels", k -> new LinkedHashMap<String, String>())).put(key, value);
    return this;
  }

  /** Keep the snapshot the fork takes (billed as storage); otherwise it is deleted. */
  public ForkOptions keepSnapshot(boolean keep) {
    return set("keepSnapshot", keep);
  }

  /**
   * The egress secrets the copies may use, by name: only those of your egress secrets that would
   * otherwise reach them. An empty list is none; leave it unset (or pass null) to keep this
   * sandbox's list. Fixed for the copies' life; it may only narrow this sandbox's list.
   */
  public ForkOptions secrets(List<String> names) {
    return set("secrets", names == null ? null : new ArrayList<>(names));
  }

  /** Not sent: how long this fork waits for room when no server has one; null is the client's. */
  Duration waitForCapacity;

  /**
   * Replaces the client's wait for room for this fork, as for a create; {@code Duration.ZERO}
   * fails at once when no server has room for a copy.
   */
  public ForkOptions waitForCapacity(Duration wait) {
    this.waitForCapacity = wait;
    return this;
  }

  /** @deprecated Accepted and ignored: copies run on the free usage first, then prepaid credit. */
  @Deprecated
  public ForkOptions funding(String funding) {
    return set("funding", funding);
  }
}
