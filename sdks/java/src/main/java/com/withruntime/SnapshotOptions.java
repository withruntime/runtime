package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/** A snapshot's fields, every one optional. */
public final class SnapshotOptions extends Params<SnapshotOptions> {
  public SnapshotOptions() {}

  public SnapshotOptions name(String name) {
    return set("name", name);
  }

  @SuppressWarnings("unchecked")
  public SnapshotOptions label(String key, String value) {
    ((Map<String, String>) body.computeIfAbsent("labels", k -> new LinkedHashMap<String, String>())).put(key, value);
    return this;
  }

  /** Days it is kept, 1 to 365. */
  public SnapshotOptions retentionDays(int days) {
    return set("retentionDays", days);
  }
}
