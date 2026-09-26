package com.withruntime;

import java.util.List;

/** Identity and shared catalogs apply across products. */
public final class IdentityProducts {
  private IdentityProducts() {}

  public static final class SSO {
    private final Transport t;

    SSO(Transport t) {
      this.t = t;
    }

    /** Read this organization's SSO settings; configure them in the owner console. */
    public JsonObject get() {
      return NetworkProducts.object(t, "GET", "/v1/sso", null);
    }
  }

  public static final class MCP {
    private final Transport t;

    MCP(Transport t) {
      this.t = t;
    }

    public List<JsonObject> catalog() {
      return NetworkProducts.list(t, new Transport.Call("GET", "/v1/mcp/catalog"));
    }
  }
}
