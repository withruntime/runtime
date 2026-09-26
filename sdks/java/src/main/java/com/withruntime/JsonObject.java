package com.withruntime;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * An answer from the API: the whole JSON object, with typed getters. Every typed model (a
 * sandbox, a command result, a volume...) is one of these, so a field newer than this SDK is
 * still there in {@link #raw()} and {@link #get(String)}.
 */
public class JsonObject {
  private final Map<String, Object> raw;

  public JsonObject(Map<String, Object> raw) {
    this.raw = raw == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(raw));
  }

  /** Reads a JSON object from an API answer: an empty answer is an empty object. */
  @SuppressWarnings("unchecked")
  static Map<String, Object> map(Object value) {
    return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
  }

  /** The whole object as the API sent it. */
  public Map<String, Object> raw() {
    return raw;
  }

  /** A field, or null. */
  public Object get(String name) {
    return raw.get(name);
  }

  public boolean has(String name) {
    return raw.containsKey(name) && raw.get(name) != null;
  }

  /** A string field, or null. */
  public String getString(String name) {
    Object value = raw.get(name);
    return value == null ? null : value instanceof String text ? text : String.valueOf(value);
  }

  /** A whole-number field, or null. */
  public Long getLong(String name) {
    Object value = raw.get(name);
    if (value instanceof Number number) return number.longValue();
    if (value instanceof String text) {
      try {
        return Long.parseLong(text);
      } catch (NumberFormatException error) {
        return null;
      }
    }
    return null;
  }

  /** A whole-number field, or the fallback. */
  public long getLong(String name, long fallback) {
    Long value = getLong(name);
    return value == null ? fallback : value;
  }

  /** A number field, or null. */
  public Double getDouble(String name) {
    return raw.get(name) instanceof Number number ? number.doubleValue() : null;
  }

  /** A boolean field; absent is false. */
  public boolean getBoolean(String name) {
    return Boolean.TRUE.equals(raw.get(name));
  }

  /** A time field, or null. */
  public Instant getInstant(String name) {
    String text = getString(name);
    return text == null ? null : Instant.parse(text);
  }

  /** An object field, or an empty object. */
  public JsonObject getObject(String name) {
    return new JsonObject(map(raw.get(name)));
  }

  /** An object field as a string map, or an empty map. */
  public Map<String, String> getStringMap(String name) {
    Map<String, String> out = new LinkedHashMap<>();
    for (Map.Entry<String, Object> entry : map(raw.get(name)).entrySet())
      out.put(entry.getKey(), entry.getValue() == null ? null : String.valueOf(entry.getValue()));
    return out;
  }

  /** An array field, or an empty list. */
  public List<Object> getList(String name) {
    Object value = raw.get(name);
    return value instanceof List<?> list ? Collections.unmodifiableList(list) : List.of();
  }

  /** An array field of strings, or an empty list. */
  public List<String> getStrings(String name) {
    List<String> out = new ArrayList<>();
    for (Object item : getList(name)) out.add(item == null ? null : String.valueOf(item));
    return out;
  }

  /** An array field of objects, or an empty list. */
  public List<JsonObject> getObjects(String name) {
    return getObjects(name, JsonObject::new);
  }

  <T> List<T> getObjects(String name, Function<Map<String, Object>, T> make) {
    List<T> out = new ArrayList<>();
    for (Object item : getList(name)) out.add(make.apply(map(item)));
    return out;
  }

  @Override
  public String toString() {
    return Json.write(raw);
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof JsonObject object && object.raw.equals(raw);
  }

  @Override
  public int hashCode() {
    return raw.hashCode();
  }
}
