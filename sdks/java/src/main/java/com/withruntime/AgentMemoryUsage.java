package com.withruntime;

import java.util.Map;

/** An agent's whole memory, every scope: what storage is billed on, and its bounds. */
public final class AgentMemoryUsage extends JsonObject {
  AgentMemoryUsage(Map<String, Object> raw) {
    super(raw);
  }

  public long bytes() {
    return getLong("bytes", 0);
  }

  public long files() {
    return getLong("files", 0);
  }

  public long limitBytes() {
    return getLong("limitBytes", 0);
  }

  public long limitFiles() {
    return getLong("limitFiles", 0);
  }
}
