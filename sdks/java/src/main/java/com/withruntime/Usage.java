package com.withruntime;

import java.math.BigInteger;
import java.util.Map;

/**
 * The account's money and trial time. Money is integer microdollars, exact past 2^53: available =
 * credited - spent - expired - held.
 */
public final class Usage extends JsonObject {
  Usage(Map<String, Object> raw) {
    super(raw);
  }

  private BigInteger micros(String name) {
    String value = getString(name);
    return value == null ? BigInteger.ZERO : new BigInteger(value);
  }

  public String orgId() {
    return getString("orgId");
  }

  public BigInteger creditedMicros() {
    return micros("credited");
  }

  public BigInteger spentMicros() {
    return micros("spent");
  }

  public BigInteger heldMicros() {
    return micros("held");
  }

  public BigInteger expiredMicros() {
    return micros("expired");
  }

  /** What can still be spent. */
  public BigInteger availableMicros() {
    return micros("available");
  }

  /** The trial's milliseconds: totalMs, usedMs, reservedMs and availableMs; empty when none. */
  public JsonObject trial() {
    return getObject("trial");
  }
}
