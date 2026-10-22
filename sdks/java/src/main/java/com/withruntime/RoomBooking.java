package com.withruntime;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Room booked for a burst: {@link #sandboxes()} sandboxes of one size held for a window. A decline
 * is a normal answer, not an exception: {@link #status()} is "declined" and {@link #reason()},
 * {@link #message()}, {@link #largestSandboxes()} and {@link #nearestWindow()} say why and what
 * would fit.
 */
public final class RoomBooking extends JsonObject {
  RoomBooking(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  /** "confirmed", "declined" or "cancelled". */
  public String status() {
    return getString("status");
  }

  public boolean confirmed() {
    return "confirmed".equals(status());
  }

  /** Standing room: held from when it was booked until it is cancelled, with no window. */
  public boolean standing() {
    return getBoolean("standing");
  }

  /** Standing room's snapshots: it is held on the servers holding them. Empty: any server. */
  public List<String> snapshots() {
    return getStrings("snapshots");
  }

  /** Held for the key that booked it alone. */
  public boolean forKey() {
    return getBoolean("forKey");
  }

  /** Why it was declined: "room", "share", "usage" or "credit"; null otherwise. */
  public String reason() {
    return getString("reason");
  }

  /** What happened, in words. */
  public String message() {
    return getString("message");
  }

  public String region() {
    return getString("region");
  }

  public int sandboxes() {
    return (int) getLong("sandboxes", 0);
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

  public Instant startsAt() {
    return getInstant("startsAt");
  }

  /** The window's end; null for standing room. */
  public Instant endsAt() {
    return getInstant("endsAt");
  }

  /** The end of the window while confirmed; otherwise null. */
  public Instant heldUntil() {
    return getInstant("heldUntil");
  }

  /** "upcoming", "active" or "ended" while confirmed; otherwise null. */
  public String phase() {
    return getString("phase");
  }

  /** The most sandboxes of this size that window could hold. */
  public int largestSandboxes() {
    return (int) getLong("largestSandboxes", 0);
  }

  /** A declined booking's nearest window that takes them all ({@code startsAt}, {@code endsAt}), or null. */
  public JsonObject nearestWindow() {
    return has("nearestWindow") ? getObject("nearestWindow") : null;
  }

  /** The most it can cost: every sandbox running the whole window (any mix of running and unused costs less), in microdollars as a string. */
  public String estimateMicros() {
    return getString("estimateMicros");
  }

  /** What booked room no sandbox of the account uses costs per GiB-hour of the booked sandboxes' memory, as quoted when booked ("0" before it had a price), in microdollars as a string. */
  public String unusedRateMicros() {
    return getString("unusedRateMicros");
  }

  /** The most it costs if none of its sandboxes run (nothing if cancelled at least an hour before it starts), in microdollars as a string. */
  public String unusedMaxMicros() {
    return getString("unusedMaxMicros");
  }

  /** The most its unused room costs an hour, in microdollars as a string. */
  public String unusedPerHourMicros() {
    return getString("unusedPerHourMicros");
  }

  /** What its unused room has been charged so far, in microdollars as a string. */
  public String unusedChargedMicros() {
    return getString("unusedChargedMicros");
  }

  public int inUse() {
    return (int) getLong("inUse", 0);
  }

  public int peakInUse() {
    return (int) getLong("peakInUse", 0);
  }

  public int releasedPercent() {
    return (int) getLong("releasedPercent", 0);
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }

  public Instant cancelledAt() {
    return getInstant("cancelledAt");
  }
}
