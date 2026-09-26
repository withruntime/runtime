package com.withruntime;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Function;

/**
 * One connection pool, one retry policy and one error shape for every product: the same rules as
 * the JavaScript, Python and Go SDKs. Writes carry an idempotency key, made per call and kept
 * across the client's own retries; transport failures, 429, 502, 503 and 504 are retried with
 * backoff and jitter; a create waits out a full trial, quota or region.
 */
final class Transport {
  final String baseUrl;
  final String apiKey;
  final Duration timeout;
  final int maxRetries;
  final Duration waitForCapacity;
  final HttpClient http;
  private final Semaphore slots;
  private final String client;

  Transport(RuntimeClient.Builder options, String apiKey, String baseUrl) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeout = options.timeout;
    this.maxRetries = options.maxRetries;
    this.waitForCapacity = options.waitForCapacity;
    this.slots = new Semaphore(Math.max(1, options.maxConnections), true);
    this.client = "sdk-java/" + RuntimeClient.VERSION;
    HttpClient.Builder builder =
        HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NEVER)
            .connectTimeout(Duration.ofSeconds(30));
    ProxySelector proxy = EnvProxy.from(System.getenv());
    if (proxy != null) builder.proxy(proxy);
    this.http = options.httpClient != null ? options.httpClient : builder.build();
  }

  /** Cancellation follows a stream through request headers, body reading and reconnects. */
  static final class Cancellation {
    private boolean cancelled;
    private Runnable action;

    synchronized boolean cancelled() {
      return cancelled;
    }

    void register(Runnable action) {
      boolean run;
      synchronized (this) {
        this.action = action;
        run = cancelled;
      }
      if (run) action.run();
    }

    synchronized boolean await(Duration delay) throws InterruptedException {
      long until = System.nanoTime() + delay.toNanos();
      while (!cancelled) {
        long left = until - System.nanoTime();
        if (left <= 0) return true;
        java.util.concurrent.TimeUnit.NANOSECONDS.timedWait(this, left);
      }
      return false;
    }

    void cancel() {
      Runnable current;
      synchronized (this) {
        cancelled = true;
        current = action;
        notifyAll();
      }
      if (current != null) current.run();
    }
  }

  /** One API request. */
  static final class Call {
    final String method;
    final String path;
    final List<String[]> query = new ArrayList<>();
    Object body;
    byte[] raw;
    String accept = "application/json";
    int wait;
    String key;
    boolean noRetry;
    Duration room = Duration.ZERO;
    Duration timeout;
    Cancellation cancellation;

    Call(String method, String path) {
      this.method = method;
      this.path = path;
    }

    Call query(String name, Object value) {
      if (value != null && !(value instanceof String text && text.isEmpty()))
        query.add(new String[] {name, String.valueOf(value)});
      return this;
    }

    Call body(Object value) {
      this.body = value;
      return this;
    }

    Call raw(byte[] value) {
      this.raw = value;
      return this;
    }

    Call accept(String value) {
      this.accept = value;
      return this;
    }

    Call waitSeconds(int seconds) {
      this.wait = seconds;
      return this;
    }

    Call key(String value) {
      this.key = value;
      return this;
    }

    Call noRetry() {
      this.noRetry = true;
      return this;
    }

    Call room(Duration value) {
      this.room = value;
      return this;
    }

    Call cancellation(Cancellation value) {
      this.cancellation = value;
      return this;
    }

    Call timeout(Duration value) {
      this.timeout = value;
      return this;
    }
  }

  /** Percent-encodes one path segment, as encodeURIComponent does. */
  static String segment(String value) {
    StringBuilder out = new StringBuilder();
    for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
      int c = b & 0xff;
      if ((c >= 'a' && c <= 'z')
          || (c >= 'A' && c <= 'Z')
          || (c >= '0' && c <= '9')
          || "-_.!~*'()".indexOf(c) >= 0) out.append((char) c);
      else out.append('%').append(String.format("%02X", c));
    }
    return out.toString();
  }

  private static String component(String value) {
    return segment(value).replace("%20", "+");
  }

  URI uri(Call call) {
    StringBuilder target = new StringBuilder(baseUrl).append(call.path);
    char separator = '?';
    for (String[] pair : call.query) {
      target.append(separator).append(component(pair[0])).append('=').append(component(pair[1]));
      separator = '&';
    }
    return URI.create(target.toString());
  }

  static Duration backoff(int attempt) {
    double base = Math.min(8000, 250 * Math.pow(2, Math.min(attempt, 10)));
    return Duration.ofMillis((long) (base * (0.5 + ThreadLocalRandom.current().nextDouble())));
  }

  /** 0.5 s, 1 s, 2 s, 4 s, then every 8 s, jittered, so a queue of CI jobs spreads out. */
  static Duration roomBackoff(int attempt) {
    double base = Math.min(8000, 500 * Math.pow(2, Math.min(attempt, 10)));
    return Duration.ofMillis(
        (long) (base * (0.75 + ThreadLocalRandom.current().nextDouble() * 0.5)));
  }

  private static void sleep(Duration duration) throws InterruptedException {
    long millis = duration.toMillis();
    if (millis > 0) Thread.sleep(millis);
  }

  RuntimeCloudException.Connection connectionError(
      boolean timedOut, boolean write, String key, Throwable cause) {
    if (timedOut)
      return new RuntimeCloudException.Connection(
          "The call was cancelled or ran past its deadline.",
          "timeout",
          "Allow a longer timeout for a long call, or retry with the same idempotency key.",
          key,
          cause);
    return new RuntimeCloudException.Connection(
        write
            ? "No answer from Runtime at "
                + baseUrl
                + ". The change may have happened; retrying with the same idempotency key is safe."
            : "No answer from Runtime at " + baseUrl + ".",
        "connection_error",
        "Check the network, HTTPS_PROXY, and RUNTIME_API_URL if you set it.",
        key,
        cause);
  }

  /**
   * Sends a call and returns the response once it succeeded. The caller reads and closes the body.
   */
  HttpResponse<InputStream> send(Call call) {
    boolean write = !call.method.equals("GET");
    String key = write ? (call.key != null ? call.key : UUID.randomUUID().toString()) : null;
    Duration limit = (call.timeout != null ? call.timeout : timeout).plus(call.room);
    long deadline = System.nanoTime() + limit.toNanos();
    long roomUntil = System.nanoTime() + call.room.toNanos();
    int roomAttempt = 0;
    byte[] payload = null;
    String contentType = null;
    if (call.raw != null) {
      payload = call.raw;
      contentType = "application/octet-stream";
    } else if (call.body != null) {
      payload = Json.write(call.body).getBytes(StandardCharsets.UTF_8);
      contentType = "application/json";
    }
    URI uri = uri(call);
    for (int attempt = 0; ; attempt++) {
      if (call.cancellation != null && call.cancellation.cancelled())
        throw connectionError(true, write, key, null);
      long left = deadline - System.nanoTime();
      if (left <= 0) throw connectionError(true, write, key, null);
      HttpRequest.Builder request =
          HttpRequest.newBuilder(uri)
              .timeout(Duration.ofNanos(left))
              .header("Authorization", "Bearer " + apiKey)
              .header("Accept", call.accept)
              .header("X-Runtime-Client", client)
              .header("User-Agent", "withruntime-java/" + RuntimeClient.VERSION)
              .method(
                  call.method,
                  payload == null
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofByteArray(payload));
      if (uri.getScheme().equals("http")) request.version(HttpClient.Version.HTTP_1_1);
      if (contentType != null) request.header("Content-Type", contentType);
      if (key != null) request.header("Idempotency-Key", key);
      if (call.wait > 0) request.header("Prefer", "wait=" + Math.min(120, call.wait));
      HttpResponse<InputStream> response;
      try {
        if (call.cancellation == null) {
          response = http.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
        } else {
          CompletableFuture<HttpResponse<InputStream>> pending =
              http.sendAsync(request.build(), HttpResponse.BodyHandlers.ofInputStream());
          call.cancellation.register(() -> pending.cancel(true));
          try {
            response = pending.get();
          } catch (CancellationException cancelled) {
            throw connectionError(true, write, key, cancelled);
          } catch (ExecutionException failed) {
            if (failed.getCause() instanceof IOException io) throw io;
            throw connectionError(call.cancellation.cancelled(), write, key, failed.getCause());
          }
          InputStream responseBody = response.body();
          call.cancellation.register(
              () -> {
                try {
                  responseBody.close();
                } catch (IOException ignored) {
                }
              });
          if (call.cancellation.cancelled()) throw connectionError(true, write, key, null);
        }
        if (response.statusCode() >= 300 && response.statusCode() < 400) {
          response.body().close();
          throw new IOException("Runtime answered a redirect (" + response.statusCode() + ")");
        }
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw connectionError(true, write, key, interrupted);
      } catch (IOException failure) {
        boolean late =
            failure instanceof HttpTimeoutException
                || System.nanoTime() >= deadline
                || (call.cancellation != null && call.cancellation.cancelled());
        if (late || call.noRetry || attempt >= maxRetries)
          throw connectionError(late, write, key, failure);
        pause(backoff(attempt), deadline, write, key, failure, call.cancellation);
        continue;
      }
      int status = response.statusCode();
      if (status < 300) return response;
      Object parsed;
      String text = readText(response);
      try {
        parsed = Json.parse(text);
      } catch (IllegalArgumentException notJson) {
        String message = text.isBlank() ? null : text.strip();
        if (message != null && message.length() > 500) message = message.substring(0, 500);
        Map<String, Object> error = new LinkedHashMap<>();
        if (message != null) error.put("message", message);
        parsed = Map.of("error", error);
      }
      RuntimeCloudException failure = RuntimeCloudException.from(status, parsed, key);
      if (!call.noRetry
          && !call.room.isZero()
          && RuntimeCloudException.WAITS_FOR_ROOM.contains(failure.code())
          && !"count".equals(failure.details().get("field"))) {
        long roomLeft = roomUntil - System.nanoTime();
        if (roomLeft <= 0) throw failure;
        Duration wait =
            failure.retryAfter() != null ? failure.retryAfter() : roomBackoff(roomAttempt);
        roomAttempt++;
        pause(
            min(Duration.ofNanos(roomLeft), wait),
            deadline,
            write,
            key,
            failure,
            call.cancellation);
        attempt--;
        continue;
      }
      boolean retryable =
          (status == 429 || status == 502 || status == 503 || status == 504)
              && !RuntimeCloudException.DELIBERATE.contains(failure.code());
      if (call.noRetry || !retryable || attempt >= maxRetries) throw failure;
      Duration wait = failure.retryAfter();
      if (wait == null) {
        String header = response.headers().firstValue("Retry-After").orElse("");
        try {
          double seconds = Double.parseDouble(header);
          wait = seconds > 0 ? Duration.ofMillis((long) (seconds * 1000)) : backoff(attempt);
        } catch (NumberFormatException none) {
          wait = backoff(attempt);
        }
      }
      wait = min(Duration.ofSeconds(30), wait);
      wait =
          Duration.ofMillis(
              (long) (wait.toMillis() * (0.9 + ThreadLocalRandom.current().nextDouble() * 0.2)));
      pause(wait, deadline, write, key, failure, call.cancellation);
    }
  }

  private static Duration min(Duration a, Duration b) {
    return a.compareTo(b) <= 0 ? a : b;
  }

  /** Sleeps before a retry, unless the deadline comes first. */
  private void pause(
      Duration wait,
      long deadline,
      boolean write,
      String key,
      Throwable cause,
      Cancellation cancellation) {
    if (System.nanoTime() + wait.toNanos() >= deadline) {
      if (cause instanceof RuntimeCloudException failure) throw failure;
      throw connectionError(true, write, key, cause);
    }
    try {
      if (cancellation == null) sleep(wait);
      else if (!cancellation.await(wait)) throw connectionError(true, write, key, cause);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw connectionError(true, write, key, interrupted);
    }
  }

  private static String readText(HttpResponse<InputStream> response) {
    try (InputStream body = response.body()) {
      return new String(body.readNBytes(1 << 20), StandardCharsets.UTF_8);
    } catch (IOException error) {
      return "";
    }
  }

  private void take(Call call) {
    try {
      slots.acquire();
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw connectionError(true, !call.method.equals("GET"), call.key, interrupted);
    }
  }

  /** Sends a call and parses its JSON answer (null when empty). */
  Object json(Call call) {
    take(call);
    try {
      HttpResponse<InputStream> response = send(call);
      String text;
      try (InputStream body = response.body()) {
        text = new String(body.readAllBytes(), StandardCharsets.UTF_8);
      } catch (IOException error) {
        throw connectionError(false, !call.method.equals("GET"), call.key, error);
      }
      if (text.isBlank()) return null;
      try {
        return Json.parse(text);
      } catch (IllegalArgumentException error) {
        throw new RuntimeCloudException(
            "Unexpected answer from " + call.method + " " + call.path + ": " + error.getMessage(),
            "unexpected_answer",
            "Update the SDK, or report it with runtime.feedback().");
      }
    } finally {
      slots.release();
    }
  }

  /** Sends a call and returns its JSON object answer. */
  Map<String, Object> object(Call call) {
    return JsonObject.map(json(call));
  }

  /** Sends a call and returns its body. */
  byte[] bytes(Call call) {
    take(call);
    try {
      HttpResponse<InputStream> response = send(call);
      try (InputStream body = response.body()) {
        return body.readAllBytes();
      } catch (IOException error) {
        throw connectionError(false, !call.method.equals("GET"), call.key, error);
      }
    } finally {
      slots.release();
    }
  }

  /** Newline-delimited JSON events as they arrive. Streams do not hold a connection slot. */
  <T> EventStream<T> events(Call call, Function<Map<String, Object>, T> make) {
    call.accept = "application/x-ndjson";
    Cancellation cancellation = new Cancellation();
    if (call.cancellation != null) call.cancellation.register(cancellation::cancel);
    call.cancellation = cancellation;
    // The handle exists before HTTP starts, so close can cancel a request that
    // has not received headers yet, including a continuation's next request.
    return new EventStream<>() {
      private volatile EventStream<T> current;

      @Override
      T pull() {
        if (isClosed()) return null;
        if (current == null) {
          HttpResponse<InputStream> response = send(call);
          EventStream<T> opened = EventStream.ndjson(response.body(), make, Transport.this);
          current = opened;
          if (isClosed()) {
            opened.close();
            return null;
          }
        }
        return current.hasNext() ? current.next() : null;
      }

      @Override
      public void close() {
        super.close();
        cancellation.cancel();
        EventStream<T> active = current;
        if (active != null) active.close();
      }
    };
  }

  /** HTTPS_PROXY, HTTP_PROXY and NO_PROXY, read the way curl reads them. */
  static final class EnvProxy extends ProxySelector {
    private final Proxy https;
    private final Proxy http;
    private final List<String> none;

    private EnvProxy(Proxy https, Proxy http, List<String> none) {
      this.https = https;
      this.http = http;
      this.none = none;
    }

    static ProxySelector from(Map<String, String> env) {
      Proxy https = proxy(first(env, "HTTPS_PROXY", "https_proxy"));
      Proxy http = proxy(first(env, "HTTP_PROXY", "http_proxy"));
      if (https == null && http == null) return null;
      List<String> none = new ArrayList<>();
      String list = first(env, "NO_PROXY", "no_proxy");
      if (list != null)
        for (String entry : list.split(","))
          if (!entry.isBlank()) none.add(entry.strip().toLowerCase(Locale.ROOT));
      return new EnvProxy(https, http, none);
    }

    private static String first(Map<String, String> env, String upper, String lower) {
      String value = env.get(upper);
      if (value == null || value.isBlank()) value = env.get(lower);
      return value == null || value.isBlank() ? null : value.strip();
    }

    private static Proxy proxy(String value) {
      if (value == null) return null;
      URI uri = URI.create(value.contains("://") ? value : "http://" + value);
      int port = uri.getPort() > 0 ? uri.getPort() : uri.getScheme().equals("https") ? 443 : 80;
      return new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved(uri.getHost(), port));
    }

    boolean bypass(String host, int port) {
      host = host.toLowerCase(Locale.ROOT);
      for (String entry : none) {
        if (entry.equals("*")) return true;
        String name = entry;
        int colon = entry.lastIndexOf(':');
        if (colon > 0 && entry.indexOf(']') < colon) {
          if (!entry.substring(colon + 1).equals(String.valueOf(port))) continue;
          name = entry.substring(0, colon);
        }
        name = name.startsWith("*.") ? name.substring(1) : name;
        if (name.startsWith(".")
            ? host.endsWith(name) || host.equals(name.substring(1))
            : host.equals(name) || host.endsWith("." + name)) return true;
      }
      return false;
    }

    @Override
    public List<Proxy> select(URI uri) {
      Proxy chosen =
          uri.getScheme().equalsIgnoreCase("http") || uri.getScheme().equalsIgnoreCase("ws")
              ? http
              : https;
      int port =
          uri.getPort() > 0 ? uri.getPort() : uri.getScheme().matches("(?i)https|wss") ? 443 : 80;
      if (chosen == null || bypass(uri.getHost(), port)) return List.of(Proxy.NO_PROXY);
      return List.of(chosen);
    }

    @Override
    public void connectFailed(URI uri, SocketAddress address, IOException failure) {}
  }
}
