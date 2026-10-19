package com.withruntime;

import java.util.Map;

/** One running copy of an App or a Function. */
public final class AppCopy extends JsonObject {
  AppCopy(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public long version() {
    return getLong("version", 0);
  }

  public String region() {
    return getString("region");
  }

  /** starting, serving, draining, frozen or parked. */
  public String state() {
    return getString("state");
  }

  /** When it entered that state, in Unix milliseconds. */
  public long since() {
    return getLong("since", 0);
  }
}
