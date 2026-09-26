package com.withruntime;

import java.util.Map;

/** A persistent disk, with optional backups that can restore onto another host. */
public final class Volume extends JsonObject {
  Volume(Map<String, Object> raw) {
    super(raw);
  }

  public JsonObject backups() {
    return getObject("backups");
  }

  public String restoredFrom() {
    return getString("restoredFrom");
  }

  public String id() {
    return getString("id");
  }

  /** creating, ready, failed, deleting or deleted. */
  public String state() {
    return getString("state");
  }

  public String name() {
    return getString("name");
  }

  public int sizeMiB() {
    return (int) getLong("sizeMiB", 0);
  }

  public Long usedMiB() {
    return getLong("usedMiB");
  }
}
