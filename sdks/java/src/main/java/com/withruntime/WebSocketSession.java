package com.withruntime;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.URI;
import java.net.http.WebSocket;
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

/** JDK WebSocket transport shared by terminals and multiplexed TCP tunnels. */
final class WebSocketSession implements WebSocket.Listener, AutoCloseable {
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

  WebSocketSession(Transport t, Handler handler) {
    this.t = t;
    this.handler = handler;
  }

  void open(Transport.Call call) {
    URI uri = URI.create(t.uri(call).toString().replaceFirst("^http", "ws"));
    CompletableFuture<WebSocket> opening =
        t.http
            .newWebSocketBuilder()
            .connectTimeout(t.timeout)
            .header("Authorization", "Bearer " + t.apiKey)
            .header("X-Runtime-Client", "sdk-java/" + RuntimeClient.VERSION)
            .buildAsync(uri, this);
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
    socket = ws;
    if (closed.get()) {
      ws.abort();
      return;
    }
    ws.request(1);
  }

  private CompletionStage<?> received(WebSocket ws, byte[] bytes, boolean last, boolean text) {
    if (closed.get()) return CompletableFuture.completedFuture(null);
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
        handler.frame(text, message);
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

  @Override
  public CompletionStage<?> onClose(WebSocket ws, int status, String reason) {
    fail(
        status == 1000
            ? null
            : new RuntimeCloudException("WebSocket closed: " + reason, "stream_closed", null));
    return CompletableFuture.completedFuture(null);
  }

  @Override
  public void onError(WebSocket ws, Throwable failure) {
    fail(failure);
  }

  void send(boolean text, byte[] bytes) {
    synchronized (sendLock) {
      if (closed.get())
        throw new RuntimeCloudException("The stream is closed.", "stream_closed", null);
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
      WebSocket ws = socket;
      if (ws != null) ws.abort();
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
