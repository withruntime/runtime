package com.withruntime;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code sbx.previews()}: share ports of the sandbox at public HTTPS addresses under
 * runtimehost.com. WebSockets work; the server must listen on 0.0.0.0 or localhost.
 */
public final class Previews {
  private final Sandbox sandbox;

  Previews(Sandbox sandbox) {
    this.sandbox = sandbox;
  }

  private String path(String suffix) {
    return sandbox.path("/previews" + suffix);
  }

  /** Shares port privately: a token is needed. */
  public Preview create(int port) {
    return create(port, null, null);
  }

  /**
   * Shares port, or changes its visibility if it is shared already. visibility is "private" (the
   * default) or "public"; ttl is how long the returned token lasts (60 s to 7 days).
   */
  public Preview create(int port, String visibility, Duration ttl) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("port", port);
    if (visibility != null) body.put("visibility", visibility);
    if (ttl != null) body.put("ttlSeconds", ttl.toSeconds());
    return new Preview(sandbox.t.object(new Transport.Call("POST", path("")).body(body)));
  }

  /** Every shared port, each private one with a fresh token. */
  public List<Preview> list() {
    return new JsonObject(sandbox.t.object(new Transport.Call("GET", path("")))).getObjects("data", Preview::new);
  }

  /** One preview, with a fresh token of ttl (when not null) if it is private. */
  public Preview get(int port, Duration ttl) {
    return new Preview(
        sandbox.t.object(new Transport.Call("GET", path("/" + port)).query("ttlSeconds", ttl == null ? null : ttl.toSeconds())));
  }

  /** Refuses every token issued for this port so far and returns a new one. */
  public Preview rotate(int port) {
    return new Preview(sandbox.t.object(new Transport.Call("POST", path("/" + port + ":rotate"))));
  }

  /** Stops sharing port. Open connections close within seconds. */
  public void delete(int port) {
    sandbox.t.json(new Transport.Call("DELETE", path("/" + port)));
  }
}
