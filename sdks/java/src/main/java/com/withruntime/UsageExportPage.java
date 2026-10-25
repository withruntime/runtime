package com.withruntime;

import java.util.List;
import java.util.Map;

/**
 * One page of settled usage for every product the key sees. Money and quantities are exact decimal
 * strings in each row.
 */
public final class UsageExportPage extends JsonObject {
  UsageExportPage(Map<String, Object> raw) {
    super(raw);
  }

  public List<Row> data() {
    return getObjects("data", Row::new);
  }

  /** The cursor of the next page, or null: pass it with the same range. */
  public String nextCursor() {
    return getString("nextCursor");
  }

  /**
   * No row settled before this can still appear or change: the range is final once it reaches
   * until. Null when it could not be taken in time; read again.
   */
  public String finalThrough() {
    return getString("finalThrough");
  }

  /** The server's CSV: concatenate pages in order; only the first has the header. */
  public String csv() {
    return getString("csv");
  }

  /** One settled interval. */
  public static final class Row extends JsonObject {
    Row(Map<String, Object> raw) {
      super(raw);
    }

    public String intervalId() {
      return getString("intervalId");
    }

    public String resourceId() {
      return getString("resourceId");
    }

    public String kind() {
      return getString("kind");
    }

    public String settledAt() {
      return getString("settledAt");
    }

    /** Integer microdollars as an exact decimal string. */
    public String chargedMicros() {
      return getString("chargedMicros");
    }

    /**
     * The resource is deleted and every charge it will ever have settled before the page's
     * finalThrough. A volume's backups bill on until their retention ends.
     */
    public boolean isFinal() {
      return getBoolean("final");
    }
  }
}
