package com.withruntime;

import java.util.LinkedHashMap;
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

  /** What the copies run on: "trial" or "paid". Unset, they keep the source's. */
  public ForkOptions funding(String funding) {
    return set("funding", funding);
  }
}
