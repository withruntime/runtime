package com.withruntime;

import java.util.List;
import java.util.Map;

/** A CI/CD check with its jobs, in plan order and without logs. */
public final class CiCheckDetail extends CiCheck {
  CiCheckDetail(Map<String, Object> raw) {
    super(raw);
  }

  public List<CiJob> jobs() {
    return getObjects("jobs", CiJob::new);
  }
}
