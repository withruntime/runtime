package com.withruntime;

import java.time.Duration;
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

  public static final class MCP {
    private final Sandbox s;

    MCP(Sandbox s) {
      this.s = s;
    }

    /** Options: servers (catalog IDs or custom commands), optional port and replace. */
    public JsonObject start(Map<String, ?> options) {
      return NetworkProducts.object(s.t, "POST", s.path("/mcp"), options);
    }

    public JsonObject get() {
      return NetworkProducts.object(s.t, "GET", s.path("/mcp"), null);
    }

    public void stop() {
      NetworkProducts.object(s.t, "DELETE", s.path("/mcp"), null);
    }

    /** Wait until installation ends. Inspect each server's status for failures. Interruptible. */
    public JsonObject ready(Duration timeout) {
      Duration limit = timeout == null ? Duration.ofMinutes(10) : timeout;
      long deadline = System.nanoTime() + limit.toNanos();
      while (true) {
        long left = deadline - System.nanoTime();
        if (left <= 0) throw s.t.connectionError(true, false, null, null);
        JsonObject state =
            new JsonObject(
                s.t.object(
                    new Transport.Call("GET", s.path("/mcp")).timeout(Duration.ofNanos(left))));
        if (!state.getBoolean("running")
            || state.getObjects("servers").stream()
                .noneMatch(server -> "installing".equals(server.getString("status")))) return state;
        try {
          Thread.sleep(Math.max(1, Math.min(2000, (deadline - System.nanoTime()) / 1_000_000)));
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw s.t.connectionError(true, false, null, interrupted);
        }
      }
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
      return s.t.bytes(new Transport.Call("GET", path(id) + "/video").accept("video/mp4"));
    }

    public void delete(String id) {
      NetworkProducts.object(s.t, "DELETE", path(id), null);
    }
  }
}
