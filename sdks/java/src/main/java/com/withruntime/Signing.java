package com.withruntime;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.NamedParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * API keys as key pairs (ARCHITECTURE.md section 11): the SDK holds the private half and signs
 * each request; the server stores only the public half, so no bearer secret crosses the network.
 *
 * <pre>
 * Authorization: Runtime-Ed25519 Credential=&lt;32 hex&gt;,Timestamp=&lt;ns&gt;,Nonce=&lt;32 hex&gt;,Signature=&lt;128 hex&gt;
 * Runtime-Project: &lt;32 hex&gt;
 * </pre>
 *
 * <p>The signature is Ed25519 over {@code "rtr\x01" | credential (16, LE) | project (16, LE) |
 * timestamp ns (8, LE) | nonce (16) | SHA-256(body) (32) | method | "\n" | path and query | "\n"
 * | Idempotency-Key (empty when none)}, so it is good for one request, on one project, within 60
 * seconds of the server's clock. A signed write must carry an Idempotency-Key: a copy replayed
 * within the minute is then answered from the first one's commit, not run again. The front's
 * side is engines/front/crates/front/src/signed.rs; every SDK signs the same test vector to the
 * same header.
 *
 * <p>When Bouncy Castle ({@code org.bouncycastle:bcprov-jdk18on}) is on the class path, it signs:
 * about 35 µs a request. Without it the JDK's own Ed25519 (Java 15 and later) signs the same
 * signatures, about 700 µs each on JDK 21 (4 vCPU of AMD EPYC, 28 October 2026).
 */
public final class Signing {
  /** The Authorization scheme of a signed request. */
  public static final String SCHEME = "Runtime-Ed25519";

  /** How a key pair's secret starts, as RUNTIME_API_KEY or {@code apiKey} holds it. */
  public static final String PREFIX = "rtsk_";

  private static final byte[] DOMAIN = {0x72, 0x74, 0x72, 0x01};
  // PKCS #8 for an Ed25519 private key, before its 32-byte seed (RFC 8410).
  private static final byte[] PKCS8_PREFIX =
      HexFormat.of().parseHex("302e020100300506032b657004220420");
  private static final Pattern ID = Pattern.compile("[0-9a-f]{32}");
  private static final Pattern SEED = Pattern.compile("[0-9a-f]{64}");
  private static final HexFormat HEX = HexFormat.of();
  private static final SecureRandom RANDOM = new SecureRandom();
  // Bouncy Castle's RFC 8032 code, when it is on the class path: Ed25519.sign(sk, skOff, pk,
  // pkOff, m, mOff, mLen, sig, sigOff) and Ed25519.generatePublicKey(sk, skOff, pk, pkOff).
  private static final MethodHandle BC_SIGN;
  private static final MethodHandle BC_PUBLIC;

  static {
    MethodHandle sign = null;
    MethodHandle pub = null;
    try {
      Class<?> ed = Class.forName("org.bouncycastle.math.ec.rfc8032.Ed25519");
      MethodHandles.Lookup lookup = MethodHandles.publicLookup();
      Class<?> b = byte[].class;
      Class<?> i = int.class;
      sign =
          lookup.findStatic(
              ed, "sign", MethodType.methodType(void.class, b, i, b, i, b, i, i, b, i));
      pub = lookup.findStatic(ed, "generatePublicKey", MethodType.methodType(void.class, b, i, b, i));
    } catch (ReflectiveOperationException | LinkageError absent) {
      sign = null;
      pub = null;
    }
    BC_SIGN = sign;
    BC_PUBLIC = pub;
  }

  private Signing() {}

  /** A key pair as an API key: the credential its public half was registered as, and its key. */
  public static final class Key {
    private final String credential;
    private final byte[] credentialBytes;
    private final String privateKey;
    private final byte[] seed;
    private final byte[] publicBytes;
    private final PrivateKey key;

    /**
     * A key from its credential ID (32 hex characters) and its 32-byte Ed25519 private key (seed),
     * as 64 hex characters.
     *
     * @param credential the credential ID its public half was registered as
     * @param privateKey the private key, 64 lowercase hex characters
     */
    public Key(String credential, String privateKey) {
      if (credential == null
          || privateKey == null
          || !ID.matcher(credential).matches()
          || !SEED.matcher(privateKey).matches())
        throw new IllegalArgumentException(
            "A signing key is a 32-character credential ID and a 64-character private key, in"
                + " lowercase hex.");
      this.credential = credential;
      this.credentialBytes = idBytes(credential);
      this.privateKey = privateKey;
      this.seed = HEX.parseHex(privateKey);
      this.publicBytes = BC_PUBLIC == null ? null : HEX.parseHex(publicKeyOf(privateKey));
      byte[] der = new byte[PKCS8_PREFIX.length + 32];
      System.arraycopy(PKCS8_PREFIX, 0, der, 0, PKCS8_PREFIX.length);
      System.arraycopy(HEX.parseHex(privateKey), 0, der, PKCS8_PREFIX.length, 32);
      try {
        this.key = KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(der));
      } catch (GeneralSecurityException e) {
        throw new IllegalStateException("This JDK has no Ed25519 (Java 15 and later do).", e);
      }
    }

    /**
     * The credential ID.
     *
     * @return 32 hex characters
     */
    public String credential() {
      return credential;
    }

    /**
     * The public key: what is registered.
     *
     * @return 64 hex characters
     */
    public String publicKey() {
      return publicKeyOf(privateKey);
    }

    private byte[] sign(byte[] message) {
      return signWith(this, message);
    }

    /** Never the private key: a string reaches logs. */
    @Override
    public String toString() {
      return "Signing.Key[credential=" + credential + "]";
    }

    /**
     * The headers that sign one request, now, with a new random nonce. Sign each attempt anew: the
     * server takes a nonce once.
     *
     * @param project the project's ID, 32 hex characters
     * @param method the HTTP method
     * @param target the path and query exactly as sent
     * @param idempotencyKey the Idempotency-Key header sent, which a write must have; null for none
     * @param body the body's bytes as sent, or null for none
     * @return Authorization and Runtime-Project
     */
    public Map<String, String> signRequest(
        String project, String method, String target, String idempotencyKey, byte[] body) {
      byte[] nonce = new byte[16];
      RANDOM.nextBytes(nonce);
      Instant now = Instant.now();
      return signRequest(
          project,
          method,
          target,
          idempotencyKey,
          body,
          now.getEpochSecond() * 1_000_000_000L + now.getNano(),
          nonce);
    }

    /**
     * The headers that sign one request at {@code timestampNs} with {@code nonce}.
     *
     * @param project the project's ID, 32 hex characters
     * @param method the HTTP method
     * @param target the path and query exactly as sent
     * @param idempotencyKey the Idempotency-Key header sent, which a write must have; null for none
     * @param body the body's bytes as sent, or null for none
     * @param timestampNs nanoseconds since the Unix epoch
     * @param nonce 16 random bytes, never reused
     * @return Authorization and Runtime-Project
     */
    public Map<String, String> signRequest(
        String project,
        String method,
        String target,
        String idempotencyKey,
        byte[] body,
        long timestampNs,
        byte[] nonce) {
      if (project == null || !ID.matcher(project).matches())
        throw new IllegalArgumentException("The project is its 32-character ID, in lowercase hex.");
      if (nonce.length != 16) throw new IllegalArgumentException("A nonce is 16 bytes.");
      byte[] line =
          (method + "\n" + target + "\n" + (idempotencyKey == null ? "" : idempotencyKey))
              .getBytes(StandardCharsets.UTF_8);
      ByteBuffer message = ByteBuffer.allocate(92 + line.length).order(ByteOrder.LITTLE_ENDIAN);
      message.put(DOMAIN).put(credentialBytes).put(idBytes(project)).putLong(timestampNs);
      message.put(nonce).put(sha256(body == null ? new byte[0] : body)).put(line);
      byte[] signature = sign(message.array());
      Map<String, String> headers = new LinkedHashMap<>();
      headers.put(
          "Authorization",
          SCHEME
              + " Credential="
              + credential
              + ",Timestamp="
              + Long.toUnsignedString(timestampNs)
              + ",Nonce="
              + HEX.formatHex(nonce)
              + ",Signature="
              + HEX.formatHex(signature));
      headers.put("Runtime-Project", project);
      return headers;
    }
  }

  /** Signs with Bouncy Castle when present, else the JDK. */
  private static byte[] signWith(Key k, byte[] message) {
    if (BC_SIGN != null) {
      byte[] signature = new byte[64];
      try {
        BC_SIGN.invokeExact(k.seed, 0, k.publicBytes, 0, message, 0, message.length, signature, 0);
      } catch (Throwable e) {
        throw new IllegalStateException(e);
      }
      return signature;
    }
    try {
      Signature signer = Signature.getInstance("Ed25519");
      signer.initSign(k.key);
      signer.update(message);
      return signer.sign();
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  /**
   * A new key pair, made on this machine. Register the public key as an API key; keep the private
   * key secret. The server never sees it.
   *
   * @return the private key and the public key, each 64 hex characters
   */
  public static String[] generateKeyPair() {
    byte[] seed = new byte[32];
    RANDOM.nextBytes(seed);
    String privateKey = HEX.formatHex(seed);
    return new String[] {privateKey, publicKeyOf(privateKey)};
  }

  /**
   * The public key of a private key. The JDK makes an Ed25519 key pair from the 32 bytes its
   * random source gives (RFC 8032's seed), so a source that gives the seed makes its public key.
   *
   * @param privateKey 64 hex characters
   * @return 64 hex characters
   */
  public static String publicKeyOf(String privateKey) {
    byte[] seed = HEX.parseHex(privateKey);
    if (BC_PUBLIC != null) {
      byte[] pub = new byte[32];
      try {
        BC_PUBLIC.invokeExact(seed, 0, pub, 0);
      } catch (Throwable e) {
        throw new IllegalStateException(e);
      }
      return HEX.formatHex(pub);
    }
    SecureRandom fixed =
        new SecureRandom() {
          private static final long serialVersionUID = 1L;

          @Override
          public void nextBytes(byte[] bytes) {
            System.arraycopy(seed, 0, bytes, 0, bytes.length);
          }
        };
    try {
      KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519");
      generator.initialize(NamedParameterSpec.ED25519, fixed);
      byte[] spki = generator.generateKeyPair().getPublic().getEncoded();
      return HEX.formatHex(spki, spki.length - 32, spki.length);
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException("This JDK has no Ed25519 (Java 15 and later do).", e);
    }
  }

  /**
   * A key pair's secret, {@code rtsk_<credential>_<privateKey>}: what RUNTIME_API_KEY or {@code
   * apiKey} holds to sign requests instead of sending a bearer key.
   *
   * @param credential the credential ID, 32 hex characters
   * @param privateKey the private key, 64 hex characters
   * @return the secret
   */
  public static String secret(String credential, String privateKey) {
    new Key(credential, privateKey);
    return PREFIX + credential + "_" + privateKey;
  }

  /**
   * The key pair in an rtsk_ secret.
   *
   * @param secret an API key
   * @return the key, or null for any other key
   */
  public static Key parse(String secret) {
    if (secret == null || !secret.startsWith(PREFIX)) return null;
    String[] parts = secret.substring(PREFIX.length()).split("_", -1);
    if (parts.length != 2 || !ID.matcher(parts[0]).matches() || !SEED.matcher(parts[1]).matches())
      return null;
    return new Key(parts[0], parts[1]);
  }

  // An rtsk_ secret is a private key: every call that authorizes with the API key goes through
  // authorize (signs) or bearerKey (refuses it), so it is never sent, whatever the call.

  /**
   * Whether a key is a key pair's secret ({@code rtsk_}): a private key, which signs requests and
   * is never sent.
   *
   * @param key an API key
   * @return whether it starts with {@code rtsk_}
   */
  public static boolean isSigningKey(String key) {
    return key != null && key.startsWith(PREFIX);
  }

  /**
   * The key, for a call that can only send a bearer key (another platform's SDK pointed at
   * Runtime). A key pair's secret is never sent: throws for one, before anything leaves this
   * machine.
   *
   * @param key an API key
   * @param what the call, for the error
   * @return the key
   * @throws Refused for a key pair's secret
   */
  public static String bearerKey(String key, String what) {
    if (!isSigningKey(key)) return key;
    throw new Refused(
        what
            + " sends the API key as a bearer token, and this key is a key pair's private key"
            + " (rtsk_), which is never sent.",
        "Use a bearer API key (rtkey_) here; the SDK's own calls sign with the rtsk_ key.");
  }

  /**
   * A key refused before anything was sent: a key pair's secret that is malformed, has no
   * project, or was given to a call that can only send a bearer.
   */
  public static final class Refused extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;

    /** What was wrong, without the hint. */
    public final String problem;

    /** What to do instead. */
    public final String hint;

    Refused(String problem, String hint) {
      super(problem + " Nothing was sent. " + hint);
      this.problem = problem;
      this.hint = hint;
    }
  }

  /**
   * The key pair in a key, or null for a bearer key. Throws for a malformed {@code rtsk_}
   * secret, or one with no project to sign for: callers check before sending anything.
   *
   * @param key an API key
   * @param project the project's ID, 32 hex characters
   * @return the key pair, or null
   * @throws Refused for a malformed secret or a missing project
   */
  public static Key keyFor(String key, String project) {
    if (!isSigningKey(key)) return null;
    Key k = PARSED.computeIfAbsent(key, Signing::parse);
    if (k == null)
      throw new Refused(
          "The API key starts with rtsk_ but is not a key pair's secret (rtsk_<32 hex>_<64 hex>).",
          "Use the whole secret, as Signing.secret wrote it.");
    if (project == null || !ID.matcher(project).matches())
      throw new Refused(
          "A signing key (rtsk_) signs each request for one project, and none was given.",
          "Set RUNTIME_PROJECT to the project's 32-character ID, or call project() on the"
              + " builder.");
    return k;
  }

  /**
   * The headers that authorize one attempt with a key: a key pair's signature over the request
   * as sent, else {@code Authorization: Bearer}. Throws, sending nothing, for a malformed {@code
   * rtsk_} secret or one with no project. Call it for each attempt: the server takes a nonce once.
   *
   * @param key an API key
   * @param project the project's ID, for a key pair
   * @param method the method
   * @param uri the request's URI, whose raw path and query are signed
   * @param idempotencyKey the Idempotency-Key header sent, or null
   * @param body the body's bytes as sent, or null
   * @return the headers to set
   */
  public static Map<String, String> authorize(
      String key, String project, String method, URI uri, String idempotencyKey, byte[] body) {
    Key k = keyFor(key, project);
    if (k == null) return Map.of("Authorization", "Bearer " + key);
    String target = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
    return k.signRequest(project, method, target, idempotencyKey, body);
  }

  /** Secrets parsed once each: each request signs with the same loaded key. */
  private static final Map<String, Key> PARSED = new java.util.concurrent.ConcurrentHashMap<>();

  /** Whether Bouncy Castle signs (it is on the class path). */
  static boolean bouncyCastle() {
    return BC_SIGN != null;
  }

  /** A 128-bit ID's 16 bytes, little-endian, as the server reads it. */
  static byte[] idBytes(String id) {
    byte[] b = HEX.parseHex(id);
    byte[] out = new byte[16];
    for (int i = 0; i < 16; i++) out[i] = b[15 - i];
    return out;
  }

  private static byte[] sha256(byte[] body) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(body);
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }
}
