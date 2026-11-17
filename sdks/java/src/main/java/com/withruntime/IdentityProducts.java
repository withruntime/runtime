package com.withruntime;

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
}
