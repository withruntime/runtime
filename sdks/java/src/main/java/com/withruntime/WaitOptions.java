package com.withruntime;

import java.time.Duration;

/**
 * How a wait follows a resource: one deadline covers the write, its retries and every read. Every
 * field is optional.
 */
public final class WaitOptions {
  public WaitOptions() {}

  Duration timeout = Duration.ofMinutes(5);
  Duration poll = Duration.ofMillis(250);
  String idempotencyKey;

  /** The whole wait, retries included. Default 5 minutes; zero waits without a deadline. */
  public WaitOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }

  /** The delay between reads. Default 250 ms. */
  public WaitOptions poll(Duration poll) {
    this.poll = poll;
    return this;
  }

  /**
   * The write's idempotency key. Leave it unset: the client makes one before the write and keeps
   * it for the whole wait, and a timeout carries it. Set one only to retry after a restart.
   */
  public WaitOptions idempotencyKey(String key) {
    this.idempotencyKey = key;
    return this;
  }
}
