package com.withruntime;

import java.util.Map;

/** A public HTTPS address for a port inside a sandbox, under runtimehost.com. */
public final class Preview extends JsonObject {
  Preview(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public int port() {
    return (int) getLong("port", 0);
  }

  /** private (a token is needed) or public. */
  public String visibility() {
    return getString("visibility");
  }

  public String url() {
    return getString("url");
  }

  /** A private preview's token. Send it as the x-runtime-preview-token header. */
  public String token() {
    return getString("token");
  }

  /** A link that carries the token once, for a browser. */
  public String urlWithToken() {
    return getString("urlWithToken");
  }
}
