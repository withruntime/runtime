package com.withruntime;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An account opened with a wallet alone: no key, no sign-in, no browser. These two calls go to the
 * website, which holds the payment side; everything after the key goes to the API.
 *
 * <pre>{@code
 * WalletAccount opened = Wallet.openAccount(20, true);
 * // send exactly opened.amount() to one of opened.networks(), then:
 * String key = Wallet.claimAccount(opened.claimCode()).apiKey(); // once paid
 * }</pre>
 *
 * The claim code is the only way to the account's key, shown once: keep it secret. Opening an
 * account means agreeing to https://withruntime.com/legal/terms, so ask the person you work for
 * first. The website is {@code authUrl}, else RUNTIME_AUTH_URL, else https://withruntime.com.
 */
public final class Wallet {
  private Wallet() {}

  private static final Duration TIMEOUT = Duration.ofSeconds(30);

  private static final HttpClient HTTP =
      HttpClient.newBuilder()
          .followRedirects(HttpClient.Redirect.NEVER)
          .connectTimeout(TIMEOUT)
          .build();

  /**
   * Opens an account and a stablecoin top-up of {@code usd} dollars ($10 to $500: it is a new
   * account's first week). {@code acceptTerms} must be true.
   */
  public static WalletAccount openAccount(double usd, boolean acceptTerms) {
    return openAccount(usd, acceptTerms, null);
  }

  /** As {@link #openAccount(double, boolean)}, to the website at {@code authUrl}. */
  public static WalletAccount openAccount(double usd, boolean acceptTerms, String authUrl) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("usd", usd);
    body.put("acceptTerms", acceptTerms);
    return new WalletAccount(post(authUrl, "/api/wallet/topups", body));
  }

  /**
   * Exchanges a paid account's claim code for its API key, once. Until the payment arrives it
   * answers the top-up's status instead; call it again.
   */
  public static WalletClaim claimAccount(String claimCode) {
    return claimAccount(claimCode, null);
  }

  /** As {@link #claimAccount(String)}, to the website at {@code authUrl}. */
  public static WalletClaim claimAccount(String claimCode, String authUrl) {
    return new WalletClaim(post(authUrl, "/api/wallet/claim", Map.of("claimCode", claimCode)));
  }

  private static Map<String, Object> post(String authUrl, String path, Map<String, Object> body) {
    String env = System.getenv("RUNTIME_AUTH_URL");
    String origin =
        Credentials.origin(
            authUrl != null ? authUrl : env == null || env.isEmpty() ? "https://withruntime.com" : env);
    HttpRequest request =
        HttpRequest.newBuilder(URI.create(origin + path))
            .timeout(TIMEOUT)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(Json.write(body), StandardCharsets.UTF_8))
            .build();
    HttpResponse<String> response;
    try {
      response = HTTP.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    } catch (IOException | InterruptedException cause) {
      if (cause instanceof InterruptedException) Thread.currentThread().interrupt();
      throw new RuntimeCloudException.Connection(
          "No answer from " + origin + ".", "network", "Retry in a minute.", null, cause);
    }
    Map<String, Object> answer;
    try {
      answer = JsonObject.map(Json.parse(response.body()));
    } catch (IllegalArgumentException notJson) {
      answer = Map.of();
    }
    int status = response.statusCode();
    if (status < 200 || status > 299) {
      JsonObject said = new JsonObject(answer);
      String message = said.getString("error");
      String code = said.getString("code");
      throw new RuntimeCloudException(
          message != null ? message : "The request failed (HTTP " + status + ").",
          code != null ? code : status == 429 ? "rate_limited" : "request_failed",
          status,
          null,
          null,
          null,
          null,
          null,
          null);
    }
    return answer;
  }
}
