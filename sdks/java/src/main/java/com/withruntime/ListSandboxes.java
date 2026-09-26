package com.withruntime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A list's filters, every one optional. */
public final class ListSandboxes {
  public ListSandboxes() {}

  final List<String> states = new ArrayList<>();
  final Map<String, String> labels = new LinkedHashMap<>();
  boolean includeStopped;
  String name;
  Integer limit;

  /** Keep only sandboxes in these states. */
  public ListSandboxes state(String... states) {
    this.states.addAll(List.of(states));
    return this;
  }

  /** Every label given must match. */
  public ListSandboxes label(String key, String value) {
    labels.put(key, value);
    return this;
  }

  public ListSandboxes includeStopped() {
    this.includeStopped = true;
    return this;
  }

  public ListSandboxes name(String name) {
    this.name = name;
    return this;
  }

  /** The page size, up to 50. */
  public ListSandboxes limit(int limit) {
    this.limit = limit;
    return this;
  }
}
