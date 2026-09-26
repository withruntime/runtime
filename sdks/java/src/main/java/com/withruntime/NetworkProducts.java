package com.withruntime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Account networking products, independent of any one compute product. */
public final class NetworkProducts {
  private NetworkProducts() {}

  static JsonObject object(Transport t, String method, String path, Object body) {
    return new JsonObject(t.object(new Transport.Call(method, path).body(body)));
  }

  static List<JsonObject> list(Transport t, Transport.Call call) {
    return new JsonObject(t.object(call)).getObjects("data");
  }

  public static final class Domains {
    private final Transport t;

    Domains(Transport t) {
      this.t = t;
    }

    public JsonObject add(String hostname, String sandboxId, int port) {
      return object(
          t,
          "POST",
          "/v1/domains",
          Map.of("hostname", hostname, "sandboxId", sandboxId, "port", port));
    }

    public JsonObject get(String hostname) {
      return object(t, "GET", "/v1/domains/" + Transport.segment(hostname), null);
    }

    public JsonObject verify(String hostname) {
      return object(t, "POST", "/v1/domains/" + Transport.segment(hostname) + ":verify", Map.of());
    }

    public List<JsonObject> list() {
      return NetworkProducts.list(t, new Transport.Call("GET", "/v1/domains"));
    }

    public void remove(String hostname) {
      object(t, "DELETE", "/v1/domains/" + Transport.segment(hostname), null);
    }
  }

  public static final class Ports {
    private final Transport t;

    Ports(Transport t) {
      this.t = t;
    }

    public JsonObject open(String sandboxId, int port) {
      return object(t, "POST", "/v1/ports", Map.of("sandboxId", sandboxId, "port", port));
    }

    public List<JsonObject> list(String sandboxId) {
      return NetworkProducts.list(
          t, new Transport.Call("GET", "/v1/ports").query("sandboxId", sandboxId));
    }

    public void close(String id) {
      object(t, "DELETE", "/v1/ports/" + Transport.segment(id), null);
    }
  }

  public static final class Addresses {
    private final Transport t;

    Addresses(Transport t) {
      this.t = t;
    }

    /** Reserve family 4 or 6. Funding and integer rateMicros remain in the answer. */
    public JsonObject reserve(int family) {
      return object(t, "POST", "/v1/addresses", Map.of("family", family));
    }

    public List<JsonObject> list() {
      return NetworkProducts.list(t, new Transport.Call("GET", "/v1/addresses"));
    }

    public void release(String id) {
      object(t, "DELETE", "/v1/addresses/" + Transport.segment(id), null);
    }
  }

  /** The account's WireGuard network, distinct from Sandbox.openTunnel(). */
  public static final class PrivateTunnel {
    private final Transport t;

    PrivateTunnel(Transport t) {
      this.t = t;
    }

    public JsonObject get() {
      return object(t, "GET", "/v1/tunnel", null);
    }

    public JsonObject create(String subnet) {
      return object(t, "POST", "/v1/tunnel", subnet == null ? Map.of() : Map.of("subnet", subnet));
    }

    public void delete() {
      object(t, "DELETE", "/v1/tunnel", null);
    }

    /** Save config even when configReady is false: its private key is shown once. */
    public JsonObject addPeer(String name, String publicKey, List<String> routes) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("name", name);
      if (publicKey != null && !publicKey.isEmpty()) body.put("publicKey", publicKey);
      if (routes != null) body.put("routes", routes);
      Transport.Call call = new Transport.Call("POST", "/v1/tunnel/peers").body(body);
      if (publicKey == null || publicKey.isEmpty()) call.noRetry();
      return new JsonObject(t.object(call));
    }

    public JsonObject rotatePeer(String id, String publicKey) {
      Transport.Call call =
          new Transport.Call("POST", "/v1/tunnel/peers/" + Transport.segment(id) + ":rotate")
              .body(
                  publicKey == null || publicKey.isEmpty()
                      ? Map.of()
                      : Map.of("publicKey", publicKey));
      if (publicKey == null || publicKey.isEmpty()) call.noRetry();
      return new JsonObject(t.object(call));
    }

    public JsonObject removePeer(String id) {
      return object(t, "DELETE", "/v1/tunnel/peers/" + Transport.segment(id), null);
    }
  }
}
