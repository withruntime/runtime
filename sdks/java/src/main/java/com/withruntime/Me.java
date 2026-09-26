package com.withruntime;

import java.util.Map;

/** Who a key is. */
public final class Me extends JsonObject {
  Me(Map<String, Object> raw) {
    super(raw);
  }

  public String orgId() {
    return getString("orgId");
  }

  public String principalId() {
    return getString("principalId");
  }

  public String credentialId() {
    return getString("credentialId");
  }

  public String apiVersion() {
    return getString("apiVersion");
  }

  /** The account's name. */
  public String orgName() {
    return getString("orgName");
  }

  /** The role of the member who made this key: owner, admin, developer or billing. */
  public String role() {
    return getString("role");
  }
}
