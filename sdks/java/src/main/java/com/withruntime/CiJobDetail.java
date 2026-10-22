package com.withruntime;

import java.util.Map;

/** A CI/CD job with the tail of its output. */
public final class CiJobDetail extends CiJob {
  CiJobDetail(Map<String, Object> raw) {
    super(raw);
  }

  /** At most 256 KiB, the oldest dropped first. */
  public String log() {
    return getString("log");
  }
}
