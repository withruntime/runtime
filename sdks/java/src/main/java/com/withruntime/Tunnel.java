package com.withruntime;

import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

/** One authenticated sandbox connection carrying several loopback TCP streams. */
public final class Tunnel implements AutoCloseable {
  private static final int WINDOW = 1 << 20;
  private final Transport t;
  private final WebSocketSession socket;
  private final Map<Integer, Stream> streams = new ConcurrentHashMap<>();
  private final AtomicInteger next = new AtomicInteger(1);
  private final AtomicBoolean closed = new AtomicBoolean();
  private final CompletableFuture<Void> ready = new CompletableFuture<>();
  private final Object creditLock = new Object();
  private final ReentrantLock sendLock = new ReentrantLock();
  private long sent, credited;
  private volatile Throwable failure;

  private Tunnel(Sandbox sandbox) {
    t = sandbox.t;
    socket =
        new WebSocketSession(
            t,
            new WebSocketSession.Handler() {
              public void frame(boolean text, byte[] data) {
                receive(text, data);
              }

              public void ended(Throwable error) {
                finish(error);
              }
            });
    socket.open(new Transport.Call("GET", sandbox.path("/tunnel")));
    await(ready, t.timeout);
  }

  static Tunnel open(Sandbox sandbox) {
    return new Tunnel(sandbox);
  }

  private <T> T await(CompletableFuture<T> future, Duration timeout) {
    try {
      return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      close();
      throw t.connectionError(true, false, null, error);
    } catch (TimeoutException error) {
      close();
      throw t.connectionError(true, false, null, error);
    } catch (ExecutionException error) {
      if (error.getCause() instanceof RuntimeCloudException runtime) throw runtime;
      throw t.connectionError(false, false, null, error.getCause());
    }
  }

  private RuntimeCloudException failure() {
    return failure instanceof RuntimeCloudException runtime
        ? runtime
        : new RuntimeCloudException("The tunnel is closed.", "tunnel_closed", null);
  }

  private static byte[] frame(byte kind, int id, byte[] bytes) {
    return ByteBuffer.allocate(5 + bytes.length).put(kind).putInt(id).put(bytes).array();
  }

  private void control(byte kind, int id, byte[] bytes) {
    if (closed.get()) throw failure();
    socket.send(false, frame(kind, id, bytes));
  }

  private void receive(boolean text, byte[] data) {
    if (closed.get()) return;
    if (text) {
      JsonObject message =
          new JsonObject(JsonObject.map(Json.parse(new String(data, StandardCharsets.UTF_8))));
      if ("ready".equals(message.getString("type"))) ready.complete(null);
      else if ("error".equals(message.getString("type")))
        socket.fail(WebSocketSession.error(message));
      return;
    }
    if (data.length < 5)
      throw new RuntimeCloudException("Malformed tunnel frame.", "tunnel_protocol", null);
    ByteBuffer packet = ByteBuffer.wrap(data);
    byte kind = packet.get();
    int id = packet.getInt();
    byte[] bytes = new byte[packet.remaining()];
    packet.get(bytes);
    if (kind == 'a') {
      if (bytes.length != 8)
        throw new RuntimeCloudException("Malformed tunnel credit.", "tunnel_protocol", null);
      long credit = ByteBuffer.wrap(bytes).getLong();
      synchronized (creditLock) {
        if (closed.get()) return;
        if (credit < credited || credit > sent)
          throw new RuntimeCloudException("Invalid tunnel credit.", "tunnel_protocol", null);
        credited = credit;
        creditLock.notifyAll();
      }
      return;
    }
    Stream stream = streams.get(id);
    if (stream == null) return;
    switch (kind) {
      case 'o' -> stream.opened.complete(null);
      case 'd' -> {
        if (!stream.buffer.add(bytes)) {
          RuntimeCloudException overflow =
              new RuntimeCloudException(
                  "Read the response while writing requests; the stream's unread receive buffer is"
                      + " full.",
                  "tunnel_receive_overflow",
                  null);
          stream.end(overflow);
          asyncClose(id);
        }
      }
      case 'e' -> stream.buffer.end(null);
      case 'c' -> {
        String reason = new String(bytes, StandardCharsets.UTF_8);
        stream.end(
            reason.equals("done")
                ? null
                : new RuntimeCloudException(
                    "Sandbox connection ended: " + reason,
                    reason.equals("closed")
                        ? "port_closed"
                        : reason.equals("reserved") ? "port_reserved" : "tunnel_refused",
                    null));
      }
      default -> {}
    }
  }

  private void asyncClose(int id) {
    Thread worker =
        new Thread(
            () -> {
              try {
                control((byte) 'c', id, new byte[0]);
              } catch (RuntimeException ignored) {
              }
            },
            "runtime-tunnel-close");
    worker.setDaemon(true);
    worker.start();
  }

  private void finish(Throwable error) {
    if (closed.compareAndSet(false, true)) {
      failure = error;
      ready.completeExceptionally(error == null ? failure() : error);
      synchronized (creditLock) {
        creditLock.notifyAll();
      }
      for (Stream stream : streams.values()) stream.end(error);
      streams.clear();
      socket.close();
    }
  }

  @Override
  public void close() {
    finish(null);
  }

  public Stream connect(int port) {
    if (port < 1 || port > 65535) throw new IllegalArgumentException("port must be 1 to 65535");
    return openStream("tcp " + port);
  }

  public Stream ssh(String publicKey) {
    return openStream("ssh " + publicKey);
  }

  private Stream openStream(String target) {
    if (closed.get()) throw failure();
    int id = next.getAndIncrement();
    if (id <= 0) throw new IllegalStateException("Tunnel stream IDs exhausted.");
    Stream stream = new Stream(id);
    streams.put(id, stream);
    if (closed.get()) {
      stream.end(failure());
      throw failure();
    }
    try {
      control((byte) 'o', id, target.getBytes(StandardCharsets.UTF_8));
      await(stream.opened, t.timeout);
      return stream;
    } catch (RuntimeException failure) {
      stream.close();
      throw failure;
    }
  }

  /** One TCP stream. Closing output sends EOF, while input can keep reading the reply. */
  public final class Stream implements AutoCloseable {
    private final int id;
    private final WebSocketSession.Buffer buffer = new WebSocketSession.Buffer();
    private final CompletableFuture<Void> opened = new CompletableFuture<>();
    private final AtomicBoolean ended = new AtomicBoolean();
    private final Object writeLock = new Object();
    private boolean inputEnded;

    private Stream(int id) {
      this.id = id;
    }

    private void end(Throwable error) {
      if (ended.compareAndSet(false, true)) {
        buffer.end(error);
        opened.completeExceptionally(
            error == null
                ? new RuntimeCloudException(
                    "Connection closed before opening.", "tunnel_refused", null)
                : error);
        streams.remove(id);
        synchronized (creditLock) {
          creditLock.notifyAll();
        }
      }
    }

    public InputStream input() {
      return new InputStream() {
        @Override
        public int read() throws IOException {
          byte[] one = new byte[1];
          return read(one, 0, 1) < 0 ? -1 : one[0] & 255;
        }

        @Override
        public int read(byte[] data, int offset, int length) throws IOException {
          java.util.Objects.checkFromIndexSize(offset, length, data.length);
          try {
            return buffer.read(data, offset, length);
          } catch (InterruptedIOException error) {
            Stream.this.close();
            throw error;
          }
        }

        @Override
        public void close() {
          Stream.this.close();
        }
      };
    }

    public OutputStream output() {
      return new OutputStream() {
        @Override
        public void write(int value) throws IOException {
          write(new byte[] {(byte) value}, 0, 1);
        }

        @Override
        public void write(byte[] data, int offset, int length) throws IOException {
          java.util.Objects.checkFromIndexSize(offset, length, data.length);
          synchronized (writeLock) {
            if (inputEnded || ended.get()) throw new IOException("The stream is closed.");
            try {
              sendLock.lockInterruptibly();
            } catch (InterruptedException error) {
              Thread.currentThread().interrupt();
              Stream.this.close();
              throw new InterruptedIOException("Tunnel write interrupted.");
            }
            try {
              for (int at = offset; at < offset + length; at += 65536) {
                int n = Math.min(65536, offset + length - at);
                synchronized (creditLock) {
                  while (!closed.get() && !ended.get() && sent + n - credited > WINDOW)
                    try {
                      creditLock.wait();
                    } catch (InterruptedException error) {
                      Thread.currentThread().interrupt();
                      Stream.this.close();
                      throw new InterruptedIOException("Tunnel write interrupted.");
                    }
                  if (closed.get()) throw failure();
                  if (ended.get()) throw new IOException("The stream is closed.");
                  sent += n;
                }
                control((byte) 'd', id, Arrays.copyOfRange(data, at, at + n));
              }
            } finally {
              sendLock.unlock();
            }
          }
        }

        @Override
        public void close() {
          closeWrite();
        }
      };
    }

    public void closeWrite() {
      synchronized (writeLock) {
        if (inputEnded || ended.get()) return;
        inputEnded = true;
        control((byte) 'e', id, new byte[0]);
      }
    }

    @Override
    public void close() {
      if (!ended.get()) {
        end(null);
        asyncClose(id);
      }
    }
  }
}
