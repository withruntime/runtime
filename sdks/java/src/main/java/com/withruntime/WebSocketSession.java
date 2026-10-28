package com.withruntime;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.URI;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * JDK WebSocket transport shared by terminals and multiplexed TCP tunnels. It outlives a restart
 * of the API behind it (packages/cloud/src/api/tunnels.ts, "Hand-off"): on {"type":"restart"} it
 * holds what is sent and answers; on {"type":"resume"} and close 1012 it opens the socket again
 * with ?resume=&lt;token&gt;, sends {"type":"replay"} first, then what it held. Output continues
 * from the byte it stopped at, and the handler sees no close.
 */
final class WebSocketSession implements WebSocket.Listener, AutoCloseable {
  /** RFC 6455 close code 1012, Service Restart. */
  static final int SERVICE_RESTART = 1012;

  /** How long reconnecting may take: within the token's 30 s, after which the API ends it. */
  static final long RESUME_MS = 25_000;

  interface Handler {
    void frame(boolean text, byte[] bytes);

    void ended(Throwable failure);
  }

  private final Transport t;
  private final Handler handler;
  private final AtomicBoolean closed = new AtomicBoolean();
  private final Object sendLock = new Object();
  private final ByteArrayOutputStream fragment = new ByteArrayOutputStream();
  private final StringBuilder textFragment = new StringBuilder();
  private volatile WebSocket socket;
  private Transport.Call call;
  // Guarded by sendLock: sends between the restart and the resume, in order.
  private boolean paused;
  private final ArrayDeque<Object[]> held = new ArrayDeque<>();
  private volatile String resumeToken, resumeReplay;
  // The reconnect in flight: frames from it are the resume's until it is ready.
  private volatile boolean resuming;
  private volatile WebSocket attempt;
  private volatile CompletableFuture<Void> attemptReady = new CompletableFuture<>();
  // The resume's replay, sent first on the new socket.
  private volatile String replaying;
  volatile int resumes, replays;

  WebSocketSession(Transport t, Handler handler) {
    this.t = t;
    this.handler = handler;
  }

  private CompletableFuture<WebSocket> connect(Transport.Call call) {
    URI uri = URI.create(t.uri(call).toString().replaceFirst("^http", "ws"));
    return t.http
        .newWebSocketBuilder()
        .connectTimeout(t.timeout)
        .header("Authorization", "Bearer " + t.apiKey)
        .header("X-Runtime-Client", "sdk-java/" + RuntimeClient.VERSION)
        .buildAsync(uri, this);
  }

  void open(Transport.Call call) {
    this.call = call;
    CompletableFuture<WebSocket> opening = connect(call);
    try {
      socket = opening.get(t.timeout.toMillis(), TimeUnit.MILLISECONDS);
      if (closed.get()) socket.abort();
    } catch (InterruptedException failure) {
      opening.cancel(true);
      Thread.currentThread().interrupt();
      fail(failure);
      throw t.connectionError(true, false, null, failure);
    } catch (ExecutionException | TimeoutException failure) {
      opening.cancel(true);
      fail(failure);
      throw t.connectionError(failure instanceof TimeoutException, false, null, failure);
    }
  }

  @Override
  public void onOpen(WebSocket ws) {
    if (resuming) {
      if (closed.get()) {
        ws.abort();
        return;
      }
      attempt = ws;
      ws.request(1);
      return;
    }
    socket = ws;
    if (closed.get()) {
      ws.abort();
      return;
    }
    ws.request(1);
  }

  private CompletionStage<?> received(WebSocket ws, byte[] bytes, boolean last, boolean text) {
    if (closed.get() || (ws != socket && ws != attempt))
      return CompletableFuture.completedFuture(null);
    if (fragment.size() + bytes.length > 1_048_581) {
      fail(
          new RuntimeCloudException(
              "The WebSocket message exceeded its bound.", "stream_overflow", null));
      return CompletableFuture.completedFuture(null);
    }
    fragment.writeBytes(bytes);
    if (last) {
      byte[] message = fragment.toByteArray();
      fragment.reset();
      try {
        if (!handOff(ws, text, message)) handler.frame(text, message);
      } catch (RuntimeException failure) {
        fail(failure);
      }
    }
    if (!closed.get()) ws.request(1);
    return CompletableFuture.completedFuture(null);
  }

  @Override
  public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
    textFragment.append(data);
    if (textFragment.length() > 1_048_581) {
      fail(
          new RuntimeCloudException(
              "The WebSocket message exceeded its bound.", "stream_overflow", null));
      return CompletableFuture.completedFuture(null);
    }
    if (last) {
      byte[] message = textFragment.toString().getBytes(StandardCharsets.UTF_8);
      textFragment.setLength(0);
      return received(ws, message, true, true);
    }
    ws.request(1);
    return CompletableFuture.completedFuture(null);
  }

  @Override
  public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
    byte[] bytes = new byte[data.remaining()];
    data.get(bytes);
    return received(ws, bytes, last, false);
  }

  @Override
  public CompletionStage<?> onPing(WebSocket ws, ByteBuffer message) {
    ws.request(1);
    return WebSocket.Listener.super.onPing(ws, message);
  }

  @Override
  public CompletionStage<?> onPong(WebSocket ws, ByteBuffer message) {
    ws.request(1);
    return CompletableFuture.completedFuture(null);
  }

  /** Whether the message is the hand-off's own, which the handler never sees. */
  private boolean handOff(WebSocket ws, boolean text, byte[] message) {
    if (ws == attempt) {
      JsonObject reply = text ? parse(message) : null;
      if (reply != null
          && "ready".equals(reply.getString("type"))
          && Boolean.TRUE.equals(reply.get("resumed"))) {
        // Replay and held input go out before the next frame is read, so a second restart
        // is answered after them.
        synchronized (sendLock) {
          socket = ws;
          attempt = null;
          resumes++;
          try {
            if (replaying != null && !replaying.isEmpty()) {
              replays++;
              ws.sendText(Json.write(Map.of("type", "replay", "data", replaying)), true)
                  .get(t.timeout.toMillis(), TimeUnit.MILLISECONDS);
            }
            for (Object[] out : held)
              ((boolean) out[0]
                      ? ws.sendText(new String((byte[]) out[1], StandardCharsets.UTF_8), true)
                      : ws.sendBinary(ByteBuffer.wrap((byte[]) out[1]), true))
                  .get(t.timeout.toMillis(), TimeUnit.MILLISECONDS);
          } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw t.connectionError(true, false, null, failure);
          } catch (ExecutionException | TimeoutException failure) {
            throw t.connectionError(failure instanceof TimeoutException, false, null, failure);
          }
          held.clear();
          paused = false;
        }
        attemptReady.complete(null);
      } else if (reply != null && "error".equals(reply.getString("type"))) {
        attemptReady.completeExceptionally(error(reply));
      }
      return true;
    }
    if (!text || message.length > 4096) return false;
    JsonObject control = parse(message);
    if (control == null) return false;
    String type = control.getString("type");
    if ("restart".equals(type)) {
      synchronized (sendLock) {
        paused = true;
        ws.sendText("{\"type\":\"restart\"}", true);
      }
      return true;
    }
    if ("resume".equals(type) && control.getString("token") != null) {
      resumeReplay = control.getString("replay");
      resumeToken = control.getString("token");
      return true;
    }
    return false;
  }

  private static JsonObject parse(byte[] message) {
    try {
      return new JsonObject(JsonObject.map(Json.parse(new String(message, StandardCharsets.UTF_8))));
    } catch (RuntimeException notAnObject) {
      return null;
    }
  }

  /** Opens the socket again where it stopped, or fails the session. */
  private void resume() {
    String token = resumeToken;
    replaying = resumeReplay;
    resumeToken = null;
    resumeReplay = null;
    long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(RESUME_MS);
    long wait = 50;
    resuming = true;
    try {
      while (!closed.get() && System.nanoTime() < deadline) {
        attemptReady = new CompletableFuture<>();
        // A close between the loop's check and the new future would leave it unanswered.
        if (closed.get()) return;
        try {
          connect(new Transport.Call("GET", call.path).query("resume", token))
              .get(remaining(deadline), TimeUnit.NANOSECONDS);
          attemptReady.get(remaining(deadline), TimeUnit.NANOSECONDS);
          return;
        } catch (InterruptedException failure) {
          Thread.currentThread().interrupt();
          fail(failure);
          return;
        } catch (ExecutionException failure) {
          Throwable cause = failure.getCause();
          while (cause instanceof java.util.concurrent.CompletionException && cause.getCause() != null)
            cause = cause.getCause();
          if (cause instanceof RuntimeCloudException refused) {
            fail(refused);
            return;
          }
          // A 4xx other than 429: the token or the sandbox is not good, and asking again changes
          // nothing.
          if (cause instanceof WebSocketHandshakeException handshake) {
            int status = handshake.getResponse().statusCode();
            if (status >= 400 && status < 500 && status != 429) {
              fail(
                  new RuntimeCloudException(
                      "The connection closed for a restart and could not be resumed (HTTP "
                          + status
                          + ").",
                      "stream_closed",
                      null));
              return;
            }
          }
        } catch (TimeoutException tooSlow) {
          // Asked again below.
        }
        WebSocket stale = attempt;
        attempt = null;
        if (stale != null) stale.abort();
        try {
          Thread.sleep(wait);
        } catch (InterruptedException failure) {
          Thread.currentThread().interrupt();
          fail(failure);
          return;
        }
        wait = Math.min(wait * 2, 1000);
      }
      fail(
          new RuntimeCloudException(
              "The connection closed for a restart and could not be resumed.",
              "stream_closed",
              null));
    } finally {
      resuming = false;
    }
  }

  private static long remaining(long deadline) {
    return Math.max(1, deadline - System.nanoTime());
  }

  @Override
  public CompletionStage<?> onClose(WebSocket ws, int status, String reason) {
    if (ws == attempt) {
      attemptReady.completeExceptionally(
          new IOException("The resumed socket closed: " + status + " " + reason));
      return CompletableFuture.completedFuture(null);
    }
    if (socket != null && ws != socket) return CompletableFuture.completedFuture(null);
    if (status == SERVICE_RESTART && resumeToken != null && !closed.get()) {
      // Completes the closing handshake the server began; the socket is done either way.
      ws.sendClose(WebSocket.NORMAL_CLOSURE, "");
      Thread resumer = new Thread(this::resume, "runtime-java-socket-resume");
      resumer.setDaemon(true);
      resumer.start();
      return CompletableFuture.completedFuture(null);
    }
    fail(
        status == 1000
            ? null
            : new RuntimeCloudException("WebSocket closed: " + reason, "stream_closed", null));
    return CompletableFuture.completedFuture(null);
  }

  @Override
  public void onError(WebSocket ws, Throwable failure) {
    if (ws == attempt) attemptReady.completeExceptionally(failure);
    else if (socket == null || ws == socket) fail(failure);
  }

  void send(boolean text, byte[] bytes) {
    synchronized (sendLock) {
      if (closed.get())
        throw new RuntimeCloudException("The stream is closed.", "stream_closed", null);
      if (paused) {
        held.add(new Object[] {text, bytes.clone()});
        return;
      }
      CompletableFuture<WebSocket> sending =
          text
              ? socket.sendText(new String(bytes, StandardCharsets.UTF_8), true)
              : socket.sendBinary(ByteBuffer.wrap(bytes), true);
      try {
        sending.get(t.timeout.toMillis(), TimeUnit.MILLISECONDS);
      } catch (InterruptedException failure) {
        Thread.currentThread().interrupt();
        fail(failure);
        throw t.connectionError(true, false, null, failure);
      } catch (ExecutionException | TimeoutException failure) {
        fail(failure);
        throw t.connectionError(failure instanceof TimeoutException, false, null, failure);
      }
    }
  }

  void json(Map<String, ?> value) {
    send(true, Json.write(value).getBytes(StandardCharsets.UTF_8));
  }

  void fail(Throwable failure) {
    if (closed.compareAndSet(false, true)) {
      WebSocket ws = socket, reconnect = attempt;
      if (ws != null) ws.abort();
      if (reconnect != null) reconnect.abort();
      attemptReady.completeExceptionally(new IOException("closed"));
      handler.ended(failure);
    }
  }

  @Override
  public void close() {
    fail(null);
  }

  static RuntimeCloudException error(JsonObject message) {
    JsonObject e = message.getObject("error");
    return new RuntimeCloudException(
        e.getString("message") == null ? "The stream failed." : e.getString("message"),
        e.getString("code") == null ? "stream_failed" : e.getString("code"),
        e.getString("hint"));
  }

  /** Bounded bytes, no producer waits: one slow stream cannot stall the multiplex reader. */
  static final class Buffer {
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
    private int bytes, offset;
    private boolean ended;
    private Throwable failure;

    synchronized boolean add(byte[] data) {
      if (ended) return true;
      if (bytes + data.length > 1 << 20 || queue.size() >= 1024) return false;
      if (data.length > 0) {
        queue.add(data);
        bytes += data.length;
        notifyAll();
      }
      return true;
    }

    synchronized void end(Throwable failure) {
      if (!ended) {
        ended = true;
        this.failure = failure;
        notifyAll();
      }
    }

    synchronized int read(byte[] out, int start, int length) throws IOException {
      if (length == 0) return 0;
      while (queue.isEmpty() && !ended)
        try {
          wait();
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw new InterruptedIOException("Stream reading was interrupted.");
        }
      if (queue.isEmpty()) {
        if (failure instanceof RuntimeCloudException runtime) throw runtime;
        if (failure != null) throw new IOException("Stream failed", failure);
        return -1;
      }
      byte[] head = queue.peek();
      int n = Math.min(length, head.length - offset);
      System.arraycopy(head, offset, out, start, n);
      offset += n;
      bytes -= n;
      if (offset == head.length) {
        queue.remove();
        offset = 0;
      }
      return n;
    }
  }
}
