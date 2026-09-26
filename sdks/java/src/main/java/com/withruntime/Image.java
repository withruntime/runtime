package com.withruntime;

import java.util.List;
import java.util.Map;

/** A custom image to start sandboxes from. */
public final class Image extends JsonObject {
  Image(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  /** queued, building, ready, failed, deleting or deleted. */
  public String state() {
    return getString("state");
  }

  public String name() {
    return getString("name");
  }

  public Long version() {
    return getLong("version");
  }

  public List<String> tags() {
    return getStrings("tags");
  }

  /** Why a build failed. */
  public String error() {
    return getString("error");
  }

  public Long sizeBytes() {
    return getLong("sizeBytes");
  }
}
