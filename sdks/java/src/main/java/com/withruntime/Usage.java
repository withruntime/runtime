package com.withruntime;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;

/**
 * The account's money and free time. Money is integer microdollars, exact past 2^53: available =
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

  /**
   * Machine time without credit, in milliseconds: totalMs, usedMs, reservedMs, availableMs, offer
   * and renewsAt; empty when none.
   */
  public JsonObject trial() {
    return getObject("trial");
  }

  /**
   * This month's included usage, one object per product: pool, unit, quantity, used, reserved,
   * left, month and renewsAt. Empty from an API older than 5 October 2026.
   */
  public List<JsonObject> allowances() {
    return getObjects("allowances");
  }
}
