package com.withruntime;

import java.util.Map;

/** One version of an App or a Function. Only the live and previous ones keep saved copies. */
public final class AppVersion extends JsonObject {
  AppVersion(Map<String, Object> raw) {
    super(raw);
  }

  public long version() {
    return getLong("version", 0);
  }

  public boolean live() {
    return getBoolean("live");
  }

  public boolean previous() {
    return getBoolean("previous");
  }

  public boolean saved() {
    return getBoolean("saved");
  }

  /** Its deploy's id, for {@link Apps#getDeploy(String, String)}. */
  public String deploy() {
    return getString("deploy");
  }

  /** The build it was deployed from, or null for an image. */
  public String build() {
    return getString("build");
  }
}
