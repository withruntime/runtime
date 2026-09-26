package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The fields of a request, set fluently. Every options class extends it, so a field newer than
 * this SDK can always be sent with {@link #set(String, Object)}.
 *
 * @param <T> the options class, for chaining
 */
public abstract class Params<T extends Params<T>> {
  final Map<String, Object> body = new LinkedHashMap<>();
  String idempotencyKey;

  protected Params() {}

  @SuppressWarnings("unchecked")
  final T self() {
    return (T) this;
  }

  /** Sets any field of the request body, including one newer than this SDK. */
  public T set(String field, Object value) {
    if (value == null) body.remove(field);
    else body.put(field, value);
    return self();
  }

  /**
   * The idempotency key. Leave it unset: the client makes one per call and keeps it across its
   * own retries. Set your own only to retry a call yourself after your process restarted.
   */
  public T idempotencyKey(String key) {
    this.idempotencyKey = key;
    return self();
  }

  /** The request body as it will be sent. */
  public Map<String, Object> toMap() {
    return new LinkedHashMap<>(body);
  }
}
