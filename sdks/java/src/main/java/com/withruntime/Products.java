package com.withruntime;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** The account-wide products: {@code runtime.<product>().<verb>(...)}. */
public final class Products {
  private Products() {}

  /**
   * {@code runtime.secrets()}: a value your sandboxes use without seeing it. Every sandbox of the
   * organization has an environment variable of the secret's name holding a placeholder; the
   * egress proxy puts the value into HTTPS requests to its hosts. The value is never returned.
   */
  public static final class Secrets {
    private final Transport t;

    Secrets(Transport transport) {
      this.t = transport;
    }

    private static String path(String name) {
      return "/v1/egress-secrets/" + Transport.segment(name);
    }

    /** Stores or replaces a secret for these hosts (api.openai.com, *.github.com). */
    public JsonObject set(String name, String value, List<String> hosts) {
      return set(name, value, hosts, null, null);
    }

    /** With header: set that header on every request to the hosts, format's {value} replaced. */
    public JsonObject set(String name, String value, List<String> hosts, String header, String format) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("value", value);
      body.put("hosts", hosts);
      if (header != null) body.put("header", header);
      if (format != null) body.put("format", format);
      return new JsonObject(t.object(new Transport.Call("PUT", path(name)).body(body)));
    }

    /** Names, hosts and placeholders. Never values. */
    public List<JsonObject> list() {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/egress-secrets"))).getObjects("secrets");
    }

    /** Erases a secret; its placeholder stops working. */
    public void delete(String name) {
      t.json(new Transport.Call("DELETE", path(name)));
    }
  }

  /** {@code runtime.limits()}: whether this key is read-only, and what its agent may still spend today. */
  public static final class Limits {
    private final Transport t;

    Limits(Transport transport) {
      this.t = transport;
    }

    /** access, and daily: limitMicros, usedMicros, remainingMicros and window. */
    public JsonObject get() {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/limits")));
    }
  }

  /** {@code runtime.referrals()}: the account's referral link and what it earned. */
  public static final class Referrals {
    private final Transport t;

    Referrals(Transport transport) {
      this.t = transport;
    }

    public JsonObject get() {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/referrals")));
    }
  }

  /** {@code runtime.switching()}: compare usage with a rival's published rates; record a switch. */
  public static final class Switching {
    private final Transport t;

    Switching(Transport transport) {
      this.t = transport;
    }

    /**
     * Your settled usage over the last days (null is 30, at most 90) priced on Runtime and at
     * provider (e2b, daytona, vercel, modal, cloudflare, fly, fly-machines).
     */
    public JsonObject compare(String provider, Integer days) {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/usage/compare").query("provider", provider).query("days", days)));
    }

    public JsonObject get() {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/switching")));
    }

    /** Once per organization, before its first top-up. */
    public JsonObject record(String provider) {
      return new JsonObject(t.object(new Transport.Call("POST", "/v1/switching").body(Map.of("provider", provider))));
    }
  }

  /** {@code runtime.events()}: lifecycle events, newest first. */
  public static final class Events {
    private final Transport t;

    Events(Transport transport) {
      this.t = transport;
    }

    /** Either filter may be null: a resource id, and a type such as sandbox.stopped. */
    public Page<JsonObject> list(String resourceId, String type) {
      return Page.read(t, call(resourceId, type, null), JsonObject::new, cursor -> call(resourceId, type, cursor));
    }

    private static Transport.Call call(String resourceId, String type, String cursor) {
      return new Transport.Call("GET", "/v1/events").query("resourceId", resourceId).query("type", type).query("cursor", cursor);
    }
  }

  /** {@code runtime.webhooks()}: signed lifecycle events POSTed to your URL. */
  public static final class Webhooks {
    private final Transport t;

    Webhooks(Transport transport) {
      this.t = transport;
    }

    private static String path(String id, String verb) {
      return "/v1/webhooks/" + Transport.segment(id) + verb;
    }

    /** Returns the webhook with its secret, shown this once. Events null is every event. */
    public JsonObject create(String url, List<String> events, String description) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("url", url);
      if (events != null) body.put("events", events);
      if (description != null) body.put("description", description);
      return new JsonObject(t.object(new Transport.Call("POST", "/v1/webhooks").body(body)));
    }

    public List<JsonObject> list() {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/webhooks"))).getObjects("data");
    }

    public JsonObject get(String id) {
      return new JsonObject(t.object(new Transport.Call("GET", path(id, ""))));
    }

    /** Changes url, events, description or enabled; fields left out stay as they are. */
    public JsonObject update(String id, Map<String, Object> patch) {
      return new JsonObject(t.object(new Transport.Call("POST", path(id, ":update")).body(patch)));
    }

    /** A new secret, returned once. The old one keeps signing for keepPrevious (null is a day). */
    public JsonObject rotateSecret(String id, Duration keepPrevious) {
      Map<String, Object> body = keepPrevious == null ? Map.of() : Map.of("keepPreviousSeconds", keepPrevious.toSeconds());
      return new JsonObject(t.object(new Transport.Call("POST", path(id, ":rotate-secret")).body(body)));
    }

    public void delete(String id) {
      t.json(new Transport.Call("POST", path(id, ":delete")).body(Map.of()));
    }

    /** Sends a signed webhook.test now and says how your endpoint answered. */
    public JsonObject test(String id) {
      return new JsonObject(t.object(new Transport.Call("POST", path(id, ":test")).body(Map.of()).waitSeconds(10)));
    }

    /** A webhook's deliveries; state (pending, succeeded, failed, cancelled) may be null. */
    public Page<JsonObject> deliveries(String id, String state) {
      return Page.read(t, deliveriesCall(id, state, null), JsonObject::new, cursor -> deliveriesCall(id, state, cursor));
    }

    private static Transport.Call deliveriesCall(String id, String state, String cursor) {
      return new Transport.Call("GET", path(id, "/deliveries")).query("state", state).query("cursor", cursor);
    }

    /** Sends one delivery again, once, now. */
    public JsonObject retry(String deliveryId) {
      return new JsonObject(t.object(new Transport.Call("POST", "/v1/webhook-deliveries/" + Transport.segment(deliveryId) + ":retry").body(Map.of())));
    }

    /**
     * Checks a delivery's Runtime-Signature header against the raw body and your secrets (more
     * than one during a rotation), and returns the event. Refuses a signature older than five
     * minutes, which stops a captured delivery being replayed. Pass the body exactly as received.
     *
     * @throws SecurityException when the delivery is not authentic or is too old
     */
    public static JsonObject verify(byte[] body, String header, List<String> secrets) {
      return verify(body, header, secrets, Duration.ofMinutes(5), Instant.now());
    }

    static JsonObject verify(byte[] body, String header, List<String> secrets, Duration tolerance, Instant now) {
      if (header == null || header.isEmpty()) throw new SecurityException("Missing Runtime-Signature header.");
      long stamp = -1;
      List<String> given = new ArrayList<>();
      for (String part : header.split(",")) {
        String[] pair = part.strip().split("=", 2);
        if (pair.length != 2) continue;
        if (pair[0].equals("t")) {
          try {
            stamp = Long.parseLong(pair[1]);
          } catch (NumberFormatException ignored) {
            stamp = -1;
          }
        } else if (pair[0].equals("v1") && !pair[1].isEmpty()) given.add(pair[1]);
      }
      if (stamp < 0 || given.isEmpty()) throw new SecurityException("Malformed Runtime-Signature header.");
      if (Math.abs(now.getEpochSecond() - stamp) > tolerance.toSeconds())
        throw new SecurityException("The signature is too old; the delivery may be a replay.");
      byte[] prefix = (stamp + ".").getBytes(StandardCharsets.UTF_8);
      for (String secret : secrets) {
        try {
          Mac mac = Mac.getInstance("HmacSHA256");
          mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
          mac.update(prefix);
          byte[] expected = HexFormat.of().formatHex(mac.doFinal(body)).getBytes(StandardCharsets.US_ASCII);
          for (String value : given)
            if (MessageDigest.isEqual(expected, value.getBytes(StandardCharsets.US_ASCII))) {
              try {
                return new JsonObject(JsonObject.map(Json.parse(new String(body, StandardCharsets.UTF_8))));
              } catch (IllegalArgumentException notJson) {
                throw new SecurityException("The body is not JSON.");
              }
            }
        } catch (NoSuchAlgorithmException | InvalidKeyException impossible) {
          throw new IllegalStateException(impossible);
        }
      }
      throw new SecurityException("No signature matches the secret.");
    }
  }

  /** {@code runtime.otel()}: events (as logs) and CPU and memory (as metrics) pushed over OTLP/HTTP. */
  public static final class Otel {
    private final Transport t;

    Otel(Transport transport) {
      this.t = transport;
    }

    private static String path(String id, String verb) {
      return "/v1/otel-exports/" + Transport.segment(id) + verb;
    }

    /** endpoint is the OTLP/HTTP base URL; headers authenticate to it and are never shown back. */
    public JsonObject create(String endpoint, Map<String, String> headers, List<String> signals) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("endpoint", endpoint);
      if (headers != null) body.put("headers", headers);
      if (signals != null) body.put("signals", signals);
      return new JsonObject(t.object(new Transport.Call("POST", "/v1/otel-exports").body(body)));
    }

    public List<JsonObject> list() {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/otel-exports"))).getObjects("data");
    }

    public JsonObject get(String id) {
      return new JsonObject(t.object(new Transport.Call("GET", path(id, ""))));
    }

    public JsonObject update(String id, Map<String, Object> patch) {
      return new JsonObject(t.object(new Transport.Call("POST", path(id, ":update")).body(patch)));
    }

    /** Pushes now instead of at the next interval. */
    public JsonObject flush(String id) {
      return new JsonObject(t.object(new Transport.Call("POST", path(id, ":flush")).body(Map.of())));
    }

    public void delete(String id) {
      t.json(new Transport.Call("POST", path(id, ":delete")).body(Map.of()));
    }
  }

  /** {@code runtime.audit()}: the account's audit log, newest first. */
  public static final class Audit {
    private final Transport t;

    Audit(Transport transport) {
      this.t = transport;
    }

    /**
     * events and next (pass it as before). action is an action (key.created) or a group ending
     * in a dot (member.); any argument may be null.
     */
    public JsonObject list(String action, Integer limit, String before) {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/audit").query("action", action).query("limit", limit).query("before", before)));
    }
  }

  /** {@code runtime.feedback()}: tell the Runtime team something. */
  public static final class Feedback {
    private final Transport t;

    Feedback(Transport transport) {
      this.t = transport;
    }

    /**
     * kind is bug, missing_feature, competitor_gap, migration_blocker, docs, pricing, praise or
     * other. detail may be null.
     */
    public JsonObject submit(String kind, String summary, String detail) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("kind", kind);
      body.put("summary", summary);
      if (detail != null) body.put("detail", detail);
      return new JsonObject(t.object(new Transport.Call("POST", "/v1/feedback").body(body)));
    }

    /** This account's reports and where each stands. */
    public List<JsonObject> list(Integer limit) {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/feedback").query("limit", limit))).getObjects("data");
    }
  }

  /** {@code runtime.support()}: ask Runtime support. */
  public static final class Support {
    private final Transport t;

    Support(Transport transport) {
      this.t = transport;
    }

    /**
     * Sends a message, in a conversation when conversationId is not null. When the status is
     * "working", read it again in a minute. Not retried: support cannot deduplicate a message.
     */
    public JsonObject message(String message, String conversationId) {
      Map<String, Object> body = new LinkedHashMap<>();
      if (message != null) body.put("message", message);
      if (conversationId != null) body.put("conversationId", conversationId);
      return new JsonObject(t.object(new Transport.Call("POST", "/v1/support/messages").body(body).noRetry().timeout(Duration.ofMinutes(2))));
    }

    public JsonObject read(String conversationId) {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/support/conversations/" + Transport.segment(conversationId))));
    }
  }
}
