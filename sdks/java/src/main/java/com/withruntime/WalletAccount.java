package com.withruntime;

import java.util.List;
import java.util.Map;

/** An account opened with a wallet, and the stablecoin top-up that funds it. */
public final class WalletAccount extends JsonObject {
  WalletAccount(Map<String, Object> raw) {
    super(raw);
  }

  public String orgId() {
    return getString("orgId");
  }

  /** The only way to this account's key, shown once. Keep it secret. */
  public String claimCode() {
    return getString("claimCode");
  }

  /** The exact token amount to send, to six decimals. */
  public String amount() {
    return getString("amount");
  }

  /** The time the top-up must be paid by. */
  public String payBy() {
    return getString("payBy");
  }

  public String status() {
    return getString("status");
  }

  /** Where to send it: per network, a network, an address and its tokens. */
  public List<JsonObject> networks() {
    return getObjects("networks");
  }
}
