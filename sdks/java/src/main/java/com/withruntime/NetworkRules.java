package com.withruntime;

import java.util.List;

/** A sandbox's network rules, as on create and sbx.network().set(). */
public final class NetworkRules extends Params<NetworkRules> {
  public NetworkRules() {}

  /** false refuses every outbound connection. */
  public NetworkRules internet(boolean on) {
    return set("internet", on);
  }

  /** When not empty, only these web destinations: example.com, *.example.com, an address or a CIDR range. */
  public NetworkRules allow(String... destinations) {
    return set("allow", List.of(destinations));
  }

  /** Never reachable. Wins over everything. */
  public NetworkRules deny(String... destinations) {
    return set("deny", List.of(destinations));
  }

  /** host:port pairs beyond ports 80 and 443. Paid accounts only. */
  public NetworkRules connect(String... pairs) {
    return set("connect", List.of(pairs));
  }
}
