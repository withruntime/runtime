package com.withruntime;

import java.time.Instant;
import java.util.Map;

/** A file, directory or link in a sandbox. */
public final class FileEntry extends JsonObject {
  FileEntry(Map<String, Object> raw) {
    super(raw);
  }

  public String name() {
    return getString("name");
  }

  public String path() {
    return getString("path");
  }

  /** file, directory, symlink or other. */
  public String type() {
    return getString("type");
  }

  public long size() {
    return getLong("size", 0);
  }

  public String mode() {
    return getString("mode");
  }

  public Instant modifiedAt() {
    return getInstant("modifiedAt");
  }
}
