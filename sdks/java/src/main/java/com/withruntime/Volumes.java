package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * {@code runtime.volumes()}: persistent disks. Create one, then attach it when creating a sandbox
 * with {@link CreateSandbox#volume}. Backups can restore a volume onto another host.
 */
public final class Volumes {
  private final Transport t;

  Volumes(Transport transport) {
    this.t = transport;
  }

  /** Creates a volume and waits (up to 10 seconds) until it is ready. */
  public Volume create(int sizeMiB, String name, Map<String, String> labels) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("sizeMiB", sizeMiB);
    if (name != null) body.put("name", name);
    if (labels != null) body.put("labels", labels);
    return new Volume(
        t.object(new Transport.Call("POST", "/v1/volumes").body(body).waitSeconds(10)));
  }

  public Volume get(String id) {
    return new Volume(t.object(new Transport.Call("GET", "/v1/volumes/" + Transport.segment(id))));
  }

  /** The first page of volumes; either filter may be null. */
  public Page<Volume> list(String state, String name) {
    return Page.read(t, call(state, name, null), Volume::new, cursor -> call(state, name, cursor));
  }

  private static Transport.Call call(String state, String name, String cursor) {
    return new Transport.Call("GET", "/v1/volumes")
        .query("state", state)
        .query("name", name)
        .query("cursor", cursor);
  }

  /** Deletes a volume and everything on it. */
  public Volume delete(String id) {
    return new Volume(
        t.object(
            new Transport.Call("POST", "/v1/volumes/" + Transport.segment(id) + ":delete")
                .body(Map.of())));
  }

  public JsonObject backup(String id, Map<String, ?> options, String idempotencyKey) {
    return new JsonObject(
        t.object(
            new Transport.Call("POST", "/v1/volumes/" + Transport.segment(id) + ":backup")
                .body(options == null ? Map.of() : options)
                .key(idempotencyKey)
                .waitSeconds(60)));
  }

  public Volume setBackupPolicy(String id, Boolean daily, Integer retentionDays) {
    Map<String, Object> body = new LinkedHashMap<>();
    if (daily != null) body.put("daily", daily);
    if (retentionDays != null) body.put("retentionDays", retentionDays);
    return new Volume(
        t.object(
            new Transport.Call("POST", "/v1/volumes/" + Transport.segment(id) + ":backup-policy")
                .body(body)));
  }

  public JsonObject backup(String id, String name) {
    return new JsonObject(
        t.object(
            new Transport.Call("POST", "/v1/volumes/" + Transport.segment(id) + ":backup")
                .body(name == null ? Map.of() : Map.of("name", name))
                .waitSeconds(60)));
  }

  public Volume setBackupPolicy(String id, boolean daily) {
    return new Volume(
        t.object(
            new Transport.Call("POST", "/v1/volumes/" + Transport.segment(id) + ":backup-policy")
                .body(Map.of("daily", daily))));
  }

  public Page<JsonObject> backups(String volumeId, String state) {
    return Page.read(
        t,
        backupCall(volumeId, state, null),
        JsonObject::new,
        cursor -> backupCall(volumeId, state, cursor));
  }

  private static Transport.Call backupCall(String volumeId, String state, String cursor) {
    return new Transport.Call("GET", "/v1/volume-backups")
        .query("volumeId", volumeId)
        .query("state", state)
        .query("cursor", cursor);
  }

  public JsonObject getBackup(String id) {
    return NetworkProducts.object(t, "GET", "/v1/volume-backups/" + Transport.segment(id), null);
  }

  public JsonObject deleteBackup(String id) {
    return NetworkProducts.object(
        t, "POST", "/v1/volume-backups/" + Transport.segment(id) + ":delete", Map.of());
  }

  public Volume restore(String backupId, String name) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("fromBackup", backupId);
    if (name != null) body.put("name", name);
    return new Volume(
        t.object(new Transport.Call("POST", "/v1/volumes").body(body).waitSeconds(60)));
  }
}
