package com.withruntime;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Map;

/**
 * One client for every Runtime Cloud product. Make it once and share it: it is safe for concurrent
 * use and keeps its connections open.
 *
 * <pre>{@code
 * RuntimeClient runtime = RuntimeClient.create(); // RUNTIME_API_KEY, or this machine's saved connection
 * try (Sandbox sbx = runtime.sandboxes().create(new CreateSandbox().funding("trial"))) {
 *   sbx.files().write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
 *   CommandResult result = sbx.exec("python3 /workspace/invoice.py", new ExecOptions().check(true));
 *   System.out.print(result.stdout());
 * }
 * }</pre>
 *
 * <p>Every product is {@code runtime.<product>().<verb>(...)}. Money is integer microdollars
 * (1,000,000 is one US dollar).
 */
public final class RuntimeClient {
  /** This SDK's version, sent as X-Runtime-Client. */
  public static final String VERSION = "0.1.0";

  /** Runtime's API. */
  public static final String DEFAULT_BASE_URL = "https://api.withruntime.com";

  final Transport transport;
  private final Sandboxes sandboxes;
  private final Snapshots snapshots;
  private final Images images;
  private final Volumes volumes;
  private final Products.Secrets secrets;
  private final Products.Limits limits;
  private final Products.Referrals referrals;
  private final Products.Switching switching;
  private final Products.Events events;
  private final Products.Webhooks webhooks;
  private final Products.Otel otel;
  private final Products.Audit audit;
  private final Products.Feedback feedback;
  private final Products.Support support;

  private RuntimeClient(Builder builder) {
    Map<String, String> env = builder.env;
    String base = builder.baseUrl;
    if (base == null) base = env.get("RUNTIME_API_URL");
    if (base == null || base.isEmpty()) base = DEFAULT_BASE_URL;
    String origin = Credentials.origin(base);
    String key = builder.apiKey;
    if (key == null) {
      String fromEnv = env.get("RUNTIME_API_KEY");
      if (fromEnv != null && !fromEnv.isEmpty()) key = fromEnv;
      else key = Credentials.savedKey(env, origin);
    }
    if (key == null || key.isEmpty()) throw RuntimeCloudException.missingKey();
    if (key.chars().anyMatch(Character::isWhitespace))
      throw new IllegalArgumentException("The Runtime API key contains whitespace.");
    // The saved key is found by the origin as given; the calls go where that origin is reachable
    // from here.
    this.transport =
        new Transport(builder, key, Credentials.reachable(origin, Credentials::inRuntimeSandbox));
    this.sandboxes = new Sandboxes(transport);
    this.snapshots = new Snapshots(transport);
    this.images = new Images(transport);
    this.volumes = new Volumes(transport);
    this.secrets = new Products.Secrets(transport);
    this.limits = new Products.Limits(transport);
    this.referrals = new Products.Referrals(transport);
    this.switching = new Products.Switching(transport);
    this.events = new Products.Events(transport);
    this.webhooks = new Products.Webhooks(transport);
    this.otel = new Products.Otel(transport);
    this.audit = new Products.Audit(transport);
    this.feedback = new Products.Feedback(transport);
    this.support = new Products.Support(transport);
  }

  /**
   * A client with the key from RUNTIME_API_KEY, or else the connection `npx withruntime login`
   * saved for this machine. Throws {@link RuntimeCloudException.Authentication} with code
   * missing_api_key when there is neither.
   */
  public static RuntimeClient create() {
    return builder().build();
  }

  public static Builder builder() {
    return new Builder();
  }

  /** How a client is made. Every setting is optional. */
  public static final class Builder {
    String apiKey;
    String baseUrl;
    Duration timeout = Duration.ofMinutes(5);
    int maxRetries = 4;
    int maxConnections = 32;
    Duration waitForCapacity = Duration.ofMinutes(2);
    HttpClient httpClient;
    Map<String, String> env = System.getenv();

    private Builder() {}

    /** The key. Default: RUNTIME_API_KEY, then this machine's saved connection. */
    public Builder apiKey(String key) {
      if (key == null || key.isEmpty() || key.chars().anyMatch(Character::isWhitespace))
        throw new IllegalArgumentException("The API key is empty or contains whitespace.");
      this.apiKey = key;
      return this;
    }

    /**
     * Another API origin. Default: RUNTIME_API_URL, then https://api.withruntime.com. Inside a
     * Runtime sandbox, calls for https://api.withruntime.com go to http://runtime.internal.
     */
    public Builder baseUrl(String url) {
      this.baseUrl = url;
      return this;
    }

    /** The deadline for each call, retries included. Default 5 minutes. */
    public Builder timeout(Duration timeout) {
      this.timeout = timeout;
      return this;
    }

    /** How often a transport failure, 429, 502, 503 or 504 is retried. Default 4. */
    public Builder maxRetries(int retries) {
      if (retries < 0) throw new IllegalArgumentException("maxRetries cannot be negative.");
      this.maxRetries = retries;
      return this;
    }

    /** Calls in flight at once; more wait their turn. Streams do not count. Default 32. */
    public Builder maxConnections(int connections) {
      this.maxConnections = Math.max(1, connections);
      return this;
    }

    /**
     * How long a sandbox create keeps retrying, with the same key and input, when every trial slot,
     * the account's quota or the region is full. Default two minutes; zero fails at once.
     */
    public Builder waitForCapacity(Duration wait) {
      this.waitForCapacity = wait.isNegative() ? Duration.ZERO : wait;
      return this;
    }

    /**
     * Your own {@link HttpClient}. It must not follow redirects. The default honours HTTPS_PROXY
     * and NO_PROXY.
     */
    public Builder httpClient(HttpClient client) {
      this.httpClient = client;
      return this;
    }

    /** The environment to read RUNTIME_* and XDG_CONFIG_HOME from. For tests. */
    Builder env(Map<String, String> env) {
      this.env = env;
      return this;
    }

    public RuntimeClient build() {
      return new RuntimeClient(this);
    }
  }

  /** The API origin this client calls. */
  public String baseUrl() {
    return transport.baseUrl;
  }

  public Sandboxes sandboxes() {
    return sandboxes;
  }

  public Snapshots snapshots() {
    return snapshots;
  }

  public Images images() {
    return images;
  }

  public Volumes volumes() {
    return volumes;
  }

  /** Values sandboxes use on the way out without seeing them. */
  public Products.Secrets secrets() {
    return secrets;
  }

  /** What this key may do and spend. */
  public Products.Limits limits() {
    return limits;
  }

  public Products.Referrals referrals() {
    return referrals;
  }

  /** Compare usage with a rival's published rates, and record a switch. */
  public Products.Switching switching() {
    return switching;
  }

  /** Lifecycle events. */
  public Products.Events events() {
    return events;
  }

  public Products.Webhooks webhooks() {
    return webhooks;
  }

  /** OpenTelemetry export. */
  public Products.Otel otel() {
    return otel;
  }

  public Products.Audit audit() {
    return audit;
  }

  /** Tell the Runtime team something. */
  public Products.Feedback feedback() {
    return feedback;
  }

  public Products.Support support() {
    return support;
  }

  public NetworkProducts.Domains domains() {
    return new NetworkProducts.Domains(transport);
  }

  public NetworkProducts.Ports ports() {
    return new NetworkProducts.Ports(transport);
  }

  public NetworkProducts.Addresses addresses() {
    return new NetworkProducts.Addresses(transport);
  }

  public NetworkProducts.PrivateTunnel tunnel() {
    return new NetworkProducts.PrivateTunnel(transport);
  }

  public IdentityProducts.SSO sso() {
    return new IdentityProducts.SSO(transport);
  }

  public IdentityProducts.MCP mcp() {
    return new IdentityProducts.MCP(transport);
  }

  /** Who this key is: organization, agent and credential. */
  public Me me() {
    return new Me(transport.object(new Transport.Call("GET", "/v1/me")));
  }

  /** The account's credit, holds, trial time and per-resource charges. */
  public Usage usage() {
    return new Usage(transport.object(new Transport.Call("GET", "/v1/usage")));
  }

  /**
   * Calls any API path with this client's key, retries, idempotency keys and errors, and returns
   * the parsed JSON answer (a Map, a List or null). For an endpoint newer than this SDK.
   */
  public Object request(String method, String path, Map<String, ?> query, Object body) {
    if (!path.startsWith("/")) throw new IllegalArgumentException("The path must start with /.");
    Transport.Call call = new Transport.Call(method.toUpperCase(java.util.Locale.ROOT), path);
    if (query != null) query.forEach(call::query);
    if (body == null && !call.method.equals("GET") && !call.method.equals("DELETE"))
      body = Map.of();
    return transport.json(call.body(body));
  }
}
