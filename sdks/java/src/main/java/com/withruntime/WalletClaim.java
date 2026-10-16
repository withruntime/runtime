package com.withruntime;

import java.util.Map;

/** What a claim code answers: the account's key once the top-up is paid, the top-up's status before. */
public final class WalletClaim extends JsonObject {
  WalletClaim(Map<String, Object> raw) {
    super(raw);
  }

  /** "paid", or the top-up's status while it is not. */
  public String status() {
    return getString("status");
  }

  public boolean paid() {
    return "paid".equals(status());
  }

  public String orgId() {
    return getString("orgId");
  }

  /** The API key, once and only when {@link #paid()}; otherwise null. */
  public String apiKey() {
    return getString("apiKey");
  }

  /** What to do now, such as sending the top-up again when it has no address. */
  public String next() {
    return getString("next");
  }
}
