package com.withruntime;

import java.util.ArrayList;
import java.util.List;

/** A list's filters for Apps, Functions, Builds and repositories, every one optional. */
public final class ListResources {
  public ListResources() {}

  final List<String> labels = new ArrayList<>();
  final List<String> states = new ArrayList<>();
  String name;
  Integer limit;
  String cursor;

  public ListResources name(String name) {
    this.name = name;
    return this;
  }

  /** Every label given must match. */
  public ListResources label(String key, String value) {
    labels.add(key + ":" + value);
    return this;
  }

  /** Keep only these states; the default is the product's live states. */
  public ListResources state(String... states) {
    this.states.addAll(List.of(states));
    return this;
  }

  /** The page size, 1 to 100; default 50. */
  public ListResources limit(int limit) {
    this.limit = limit;
    return this;
  }

  /** Start at a page an earlier list's {@link Page#nextCursor()} named. */
  public ListResources cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  /** The list call at path from cursor (this filter's own cursor when null). */
  Transport.Call call(String path, String from) {
    Transport.Call call = new Transport.Call("GET", path).query("name", name);
    for (String label : labels) call.query("label", label);
    for (String state : states) call.query("state", state);
    return call.query("limit", limit).query("cursor", from != null ? from : cursor);
  }

  /** The first page at path, and every page after it. */
  static <T> Page<T> read(
      Transport t, String path, ListResources filter, java.util.function.Function<java.util.Map<String, Object>, T> make) {
    ListResources query = filter == null ? new ListResources() : filter;
    return Page.read(t, query.call(path, null), make, cursor -> query.call(path, cursor));
  }
}
