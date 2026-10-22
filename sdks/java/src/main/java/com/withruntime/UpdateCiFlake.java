package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/** An owner's say on an open flaky test, every field optional. */
public final class UpdateCiFlake {
  public UpdateCiFlake() {}

  private final Map<String, Object> fields = new LinkedHashMap<>();
  String idempotencyKey;

  /** Its 100 proof runs at main's next commit, when its fix landed elsewhere than its file. */
  public UpdateCiFlake prove() {
    fields.put("prove", true);
    return this;
  }

  /** Hand it to a GitHub login, or org/team. */
  public UpdateCiFlake owner(String login) {
    fields.put("owner", login);
    return this;
  }

  /** Why its test is deleted; the flake ends once main no longer holds the file. */
  public UpdateCiFlake deleteReason(String reason) {
    fields.put("deleteReason", reason);
    return this;
  }

  public UpdateCiFlake idempotencyKey(String key) {
    this.idempotencyKey = key;
    return this;
  }

  Map<String, Object> toMap() {
    return fields;
  }
}
