package com.withruntime;

import java.util.List;
import java.util.Map;

/** Additional sandbox products. Options are API field maps; responses retain all fields. */
public final class SandboxParity {
  private SandboxParity() {}

  public static final class Mounts {
    private final Sandbox s;

    Mounts(Sandbox s) {
      this.s = s;
    }

    /**
     * provider, bucket and path are required; secret names a Runtime secret, never a bucket key.
     */
    public JsonObject add(Map<String, ?> options) {
      return NetworkProducts.object(s.t, "POST", s.path("/mounts"), options);
    }

    public List<JsonObject> list() {
      return NetworkProducts.list(s.t, new Transport.Call("GET", s.path("/mounts")));
    }

    public void remove(String path) {
      NetworkProducts.object(s.t, "POST", s.path("/mounts:unmount"), Map.of("path", path));
    }
  }

  public static final class Recordings {
    private final Sandbox s;

    Recordings(Sandbox s) {
      this.s = s;
    }

    private String path(String id) {
      return s.path("/desktop/recordings") + (id == null ? "" : "/" + Transport.segment(id));
    }

    public JsonObject start(Map<String, ?> options) {
      return NetworkProducts.object(s.t, "POST", path(null), options == null ? Map.of() : options);
    }

    public JsonObject get(String id) {
      return NetworkProducts.object(s.t, "GET", path(id), null);
    }

    public List<JsonObject> list() {
      return NetworkProducts.list(s.t, new Transport.Call("GET", path(null)));
    }

    public JsonObject stop(String id) {
      return NetworkProducts.object(s.t, "POST", path(id) + ":stop", Map.of());
    }

    public byte[] download(String id) {
      return s.t.fileBytes(new Transport.Call("GET", path(id) + "/video").accept("video/mp4"));
    }

    public void delete(String id) {
      NetworkProducts.object(s.t, "DELETE", path(id), null);
    }
  }
}
