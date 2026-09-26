package com.withruntime;

import java.time.Instant;
import java.util.Map;

/** A sandbox's whole machine (files, memory, running processes), kept to start copies from. */
public final class Snapshot extends JsonObject {
  Snapshot(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  /** capturing, ready, failed, deleting or deleted. */
  public String state() {
    return getString("state");
  }

  public String name() {
    return getString("name");
  }

  public String sourceSandboxId() {
    return getString("sourceSandboxId");
  }

  public int retentionDays() {
    return (int) getLong("retentionDays", 0);
  }

  /** The bytes storage is metered for: those it alone holds. */
  public Long meteredBytes() {
    return getLong("meteredBytes");
  }

  public Instant expiresAt() {
    return getInstant("expiresAt");
  }
}
