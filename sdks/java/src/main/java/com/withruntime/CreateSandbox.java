package com.withruntime;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A create's fields, every one optional. With none you get the free trial while it lasts, the
 * default region and a 2 vCPU / 4 GiB machine for up to 30 minutes.
 */
public final class CreateSandbox extends Params<CreateSandbox> {
  public CreateSandbox() {}

  boolean noWait;
  Duration waitForCapacity;

  public CreateSandbox name(String name) {
    return set("name", name);
  }

  @SuppressWarnings("unchecked")
  public CreateSandbox label(String key, String value) {
    Map<String, String> labels = (Map<String, String>) body.computeIfAbsent("labels", k -> new LinkedHashMap<String, String>());
    labels.put(key, value);
    return this;
  }

  public CreateSandbox labels(Map<String, String> labels) {
    return set("labels", new LinkedHashMap<>(labels));
  }

  /** "trial" or "paid". Unset: the trial while it lasts, then prepaid credit. Trial never falls back to paid. */
  public CreateSandbox funding(String funding) {
    return set("funding", funding);
  }

  public CreateSandbox region(String region) {
    return set("region", region);
  }

  public CreateSandbox vcpu(int vcpu) {
    return set("vcpu", vcpu);
  }

  public CreateSandbox memoryMiB(int mib) {
    return set("memoryMiB", mib);
  }

  public CreateSandbox diskMiB(int mib) {
    return set("diskMiB", mib);
  }

  /** "shared" or "reserved". */
  public CreateSandbox cpu(String cpu) {
    return set("cpu", cpu);
  }

  /** How long it may run before its lease ends. Default 1800. */
  public CreateSandbox timeoutSeconds(int seconds) {
    return set("timeoutSeconds", seconds);
  }

  /** "pause" (the default) or "stop". */
  public CreateSandbox onLeaseEnd(String what) {
    return set("onLeaseEnd", what);
  }

  /** Pause after this many seconds with no request (60 to 86400; 0 never). */
  public CreateSandbox idlePauseSeconds(int seconds) {
    return set("idlePauseSeconds", seconds);
  }

  /** A request to a paused sandbox wakes it. Default true. */
  public CreateSandbox autoWake(boolean wake) {
    return set("autoWake", wake);
  }

  /** Keep it running while credit lasts, and keep its disk after a stop. Paid only. */
  public CreateSandbox persistent(boolean persistent) {
    return set("persistent", persistent);
  }

  /** The most it may cost over its whole life, in microdollars. */
  public CreateSandbox maxTotalCostMicros(long micros) {
    return set("maxTotalCostMicros", micros);
  }

  /** Network rules from the first start. Unset: the public web on ports 80 and 443. */
  public CreateSandbox network(NetworkRules rules) {
    return set("network", rules.toMap());
  }

  /** A ready image: its id, name (its latest tag), name:tag or name@version. */
  public CreateSandbox image(String image) {
    return set("image", image);
  }

  /** A ready snapshot's id: the sandbox starts as a copy of it. */
  public CreateSandbox snapshot(String snapshotId) {
    return set("snapshot", snapshotId);
  }

  /** Attaches a volume: mode "rw" (one sandbox at a time) or a read-only "snapshot" copy. */
  @SuppressWarnings("unchecked")
  public CreateSandbox volume(String volumeId, String path, String mode) {
    List<Object> volumes = (List<Object>) body.computeIfAbsent("volumes", k -> new ArrayList<>());
    Map<String, Object> mount = new LinkedHashMap<>();
    mount.put("volumeId", volumeId);
    mount.put("path", path);
    if (mode != null) mount.put("mode", mode);
    volumes.add(mount);
    return this;
  }

  /** Return as soon as the create is accepted, not once the sandbox runs. */
  public CreateSandbox noWait() {
    this.noWait = true;
    return this;
  }

  /** Replaces the client's wait for a full trial, quota or region; zero fails at once. */
  public CreateSandbox waitForCapacity(Duration wait) {
    this.waitForCapacity = wait;
    return this;
  }
}
