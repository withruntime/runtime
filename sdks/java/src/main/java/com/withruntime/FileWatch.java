package com.withruntime;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A guest file watch. Closing Events stops reading; stop() also stops the guest watch. */
public final class FileWatch {
  public static final class Service {
    private final Sandbox s;

    Service(Sandbox s) {
      this.s = s;
    }

    String path(String id) {
      return s.path("/files/watches") + (id == null ? "" : "/" + Transport.segment(id));
    }

    public List<JsonObject> list() {
      return NetworkProducts.list(s.t, new Transport.Call("GET", path(null)));
    }

    public JsonObject read(String id, long cursor, Duration wait) {
      return new JsonObject(
          s.t.object(
              new Transport.Call("GET", path(id) + "/events")
                  .query("cursor", cursor)
                  .query("waitMs", wait == null ? 0 : wait.toMillis())));
    }

    public void stop(String id) {
      NetworkProducts.object(s.t, "DELETE", path(id), null);
    }

    /** Options include recursive, events, include/exclude patterns and bounded lifetime. */
    public FileWatch start(String path, Map<String, ?> options) {
      Map<String, Object> body = new LinkedHashMap<>();
      if (options != null) body.putAll(options);
      body.put("path", path);
      JsonObject out = NetworkProducts.object(s.t, "POST", path(null), body);
      return new FileWatch(
          this, out.getString("id"), out.getString("path"), out.getLong("cursor", 0));
    }
  }

  private final Service service;
  private final String id, path;
  private long cursor;
  private boolean stopped;
  private Events reader;

  FileWatch(Service service, String id, String path, long cursor) {
    this.service = service;
    this.id = id;
    this.path = path;
    this.cursor = cursor;
  }

  public String id() {
    return id;
  }

  public String path() {
    return path;
  }

  public synchronized long cursor() {
    return cursor;
  }

  /** One reader at a time; after pause or close, another starts at the retained cursor. */
  public synchronized EventStream<JsonObject> events() {
    if (stopped || reader != null)
      throw new IllegalStateException("The watch is stopped or already being read.");
    reader = new Events();
    return reader;
  }

  public void stop() {
    Events active;
    synchronized (this) {
      if (stopped) return;
      stopped = true;
      active = reader;
    }
    if (active != null) active.close();
    try {
      service.stop(id);
    } catch (RuntimeException failure) {
      synchronized (this) {
        stopped = false;
      }
      throw failure;
    }
  }

  private final class Events extends EventStream<JsonObject> {
    private final Transport.Cancellation cancellation = new Transport.Cancellation();
    private volatile EventStream<JsonObject> current;
    private volatile boolean closed;
    private boolean ended;

    @Override
    JsonObject pull() {
      while (!closed && !ended) {
        if (current == null) {
          EventStream<JsonObject> opened =
              service.s.t.events(
                  new Transport.Call("GET", service.path(id) + "/events")
                      .query("cursor", cursor())
                      .query("follow", true)
                      .timeout(Duration.ofSeconds(150))
                      .cancellation(cancellation),
                  JsonObject::new);
          synchronized (this) {
            if (closed) {
              opened.close();
              return null;
            }
            current = opened;
          }
        }
        EventStream<JsonObject> active = current;
        if (!active.hasNext()) return null;
        JsonObject event = active.next();
        synchronized (FileWatch.this) {
          cursor = event.getLong("cursor", cursor);
        }
        String kind = event.getString("k");
        if ("continue".equals(kind)) {
          active.close();
          current = null;
          continue;
        }
        if ("failure".equals(kind))
          throw new RuntimeCloudException(
              event.getString("message"), event.getString("code"), null);
        if ("end".equals(kind) || "paused".equals(kind)) ended = true;
        return event;
      }
      return null;
    }

    @Override
    public void close() {
      EventStream<JsonObject> active;
      synchronized (this) {
        closed = true;
        active = current;
      }
      cancellation.cancel();
      super.close();
      if (active != null) active.close();
      synchronized (FileWatch.this) {
        if (reader == this) reader = null;
      }
    }
  }
}
