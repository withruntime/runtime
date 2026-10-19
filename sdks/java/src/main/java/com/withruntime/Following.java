package com.withruntime;

import java.time.Duration;
import java.util.Map;
import java.util.function.Function;

/**
 * A wait under one deadline, as the JavaScript SDK's {@code following}: the write, its retries
 * and every read share it, and a failure keeps the write's key. A timed-out wait can be retried
 * after a process restart with that same key.
 */
final class Following {
  final String key;
  private final Duration poll;
  private final long until;
  private final boolean bounded;
  private RuntimeCloudException issued;

  private Following(WaitOptions options, String key) {
    this.key = key;
    this.poll = options.poll;
    this.bounded = !options.timeout.isZero();
    this.until = System.nanoTime() + options.timeout.toNanos();
  }

  private static RuntimeCloudException invalid(String field) {
    return new RuntimeCloudException(
        field + " must be a nonnegative duration.",
        "invalid_request",
        0,
        "Fix the option and call again; nothing was sent.",
        null,
        Map.of("field", field),
        null,
        null,
        null);
  }

  /** Runs work under the options' deadline; key is the write's, or null for a plain wait. */
  static <T> T run(WaitOptions options, String key, Function<Following, T> work) {
    if (options == null) options = new WaitOptions();
    if (options.poll == null || options.poll.isNegative()) throw invalid("poll");
    if (options.timeout == null || options.timeout.isNegative()) throw invalid("timeout");
    Following following = new Following(options, key);
    T result;
    try {
      following.check(null);
      result = work.apply(following);
    } catch (RuntimeCloudException failure) {
      if (failure == following.issued) throw failure;
      if (following.expired()) throw following.timeout(failure);
      // A read failure still belongs to the write that started this wait.
      throw failure.withIdempotencyKey(key);
    }
    following.check(null);
    return result;
  }

  boolean expired() {
    return bounded && System.nanoTime() - until >= 0;
  }

  private void check(Throwable cause) {
    if (expired()) throw timeout(cause);
  }

  RuntimeCloudException timeout(Throwable cause) {
    return issued = new RuntimeCloudException.Connection(
        "Waiting was cancelled or reached its deadline; the resource may still change.",
        "timeout",
        "Read the resource to resume waiting. Retry a write with the same idempotency key.",
        key,
        cause);
  }

  /** The call bound to what is left of the deadline, carrying the write's key. */
  Transport.Call bound(Transport.Call call) {
    check(null);
    if (key != null) call.key(key);
    if (bounded) call.timeout(Duration.ofNanos(until - System.nanoTime()));
    return call;
  }

  /** Sleeps between reads; the deadline coming first ends the wait. */
  void pause() {
    long left = bounded ? until - System.nanoTime() : Long.MAX_VALUE;
    try {
      if (left <= poll.toNanos()) {
        if (left > 0) Thread.sleep(left / 1_000_000, (int) (left % 1_000_000));
        throw timeout(null);
      }
      Thread.sleep(poll.toMillis());
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw timeout(interrupted);
    }
  }
}
