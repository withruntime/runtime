package com.withruntime;

import java.time.Instant;
import java.util.Map;

/**
 * A file of an agent's memory, as a list, a search, a read or a write answers it: each fills the
 * fields it has (content on a read, snippet and rank on a search, created on a write); the rest
 * read null.
 */
public final class AgentMemoryFile extends JsonObject {
  AgentMemoryFile(Map<String, Object> raw) {
    super(raw);
  }

  /** "" for the shared memory, or the session key it belongs to. */
  public String scope() {
    return getString("scope");
  }

  public String path() {
    return getString("path");
  }

  /** Its text and path, in bytes, as billed. */
  public long bytes() {
    return getLong("bytes", 0);
  }

  public Instant updatedAt() {
    return getInstant("updatedAt");
  }

  /** A key's principal id, or session:&lt;id&gt; when the agent wrote it. */
  public String updatedBy() {
    return getString("updatedBy");
  }

  /** Its text, on a read. */
  public String content() {
    return getString("content");
  }

  /** Its words around the match, matches in **bold**, on a search. */
  public String snippet() {
    return getString("snippet");
  }

  /** How well it matched, on a search; higher is better. */
  public Double rank() {
    return getDouble("rank");
  }

  /** On a write: true for a new file, false for one replaced. */
  public boolean created() {
    return has("created") && getBoolean("created");
  }
}
