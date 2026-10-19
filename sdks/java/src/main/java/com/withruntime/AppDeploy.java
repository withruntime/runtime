package com.withruntime;

import java.util.Map;

/**
 * One deploy (or rollback) of an App or a Function: building, warming, switching, live, failed or
 * superseded. A failed one leaves the old version serving and says why in {@link #error()}.
 */
public final class AppDeploy extends JsonObject {
  AppDeploy(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public long version() {
    return getLong("version", 0);
  }

  public String url() {
    return getString("url");
  }

  /** building, warming, switching, live, failed or superseded. */
  public String state() {
    return getString("state");
  }

  /** Why a failed or superseded deploy ended; null otherwise. */
  public Failure error() {
    return has("error") ? new Failure(getObject("error").raw()) : null;
  }

  /** A deploy's failure: deploy_build_failed, deploy_health_failed or deploy_superseded. */
  public static final class Failure extends JsonObject {
    Failure(Map<String, Object> raw) {
      super(raw);
    }

    public String code() {
      return getString("code");
    }

    public String message() {
      return getString("message");
    }

    public String hint() {
      return getString("hint");
    }

    /** The end of the build's or the server's output. */
    public String lastOutput() {
      return getString("lastOutput");
    }
  }
}
