package com.withruntime;

import java.time.Instant;
import java.util.Map;

/** A sandbox as the API answers it. Money is integer microdollars (1,000,000 = $1). */
public final class SandboxInfo extends JsonObject {
  SandboxInfo(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String name() {
    return getString("name");
  }

  public Map<String, String> labels() {
    return getStringMap("labels");
  }

  /** starting, running, pausing, paused, resuming, stopping or stopped. */
  public String state() {
    return getString("state");
  }

  public String region() {
    return getString("region");
  }

  /** trial or paid. */
  public String funding() {
    return getString("funding");
  }

  public int vcpu() {
    return (int) getLong("vcpu", 0);
  }

  public int memoryMiB() {
    return (int) getLong("memoryMiB", 0);
  }

  public int diskMiB() {
    return (int) getLong("diskMiB", 0);
  }

  /** Its time limit in seconds; 0 is none: it runs while it works. */
  public int timeoutSeconds() {
    return (int) getLong("timeoutSeconds", 0);
  }

  public String onLeaseEnd() {
    return getString("onLeaseEnd");
  }

  /**
   * Runs until stopped while credit lasts, never paused for idleness or a time limit, and its disk
   * is kept after a stop.
   */
  public boolean persistent() {
    return getBoolean("persistent");
  }

  public boolean autoWake() {
    return getBoolean("autoWake");
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }

  /**
   * Paid up to: a time ahead of now that moves on by itself while it runs. Not when it ends; that
   * is {@link #endsAt()}.
   */
  public Instant expiresAt() {
    return getInstant("expiresAt");
  }

  /**
   * When it stops or pauses by itself: its time limit, or where its funding ends once credit or a
   * spending limit stops its renewal. Null when it never will, and when it is not running.
   */
  public Instant endsAt() {
    return getInstant("endsAt");
  }

  public Instant endedAt() {
    return getInstant("endedAt");
  }

  /** Why a sandbox stopped, when it did. */
  public String stopReason() {
    return getString("stopReason");
  }

  public long chargedMicros() {
    return getLong("chargedMicros", 0);
  }

  public long heldMicros() {
    return getLong("heldMicros", 0);
  }

  /** The answer repeats an earlier call with the same idempotency key. */
  public boolean replayed() {
    return getBoolean("replayed");
  }

  /** getOrCreate answered a sandbox that already had the name. */
  public boolean reused() {
    return getBoolean("reused");
  }
}
