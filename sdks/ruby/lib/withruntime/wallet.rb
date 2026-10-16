# frozen_string_literal: true

require "json"
require "net/http"
require "uri"

module WithRuntime
  # An account opened with a wallet alone: no key, no sign-in, no browser.
  #
  #   opened = WithRuntime::Wallet.open_account(20, accept_terms: true)
  #   # send exactly opened["amount"] to one of opened["networks"], then, once paid:
  #   key = WithRuntime::Wallet.claim_account(opened["claimCode"])["apiKey"]
  #
  # Opening one means agreeing to https://withruntime.com/legal/terms, so ask the
  # person you work for first. The claim code is shown once and is the only way
  # to the account's key: keep it secret. These two calls go to the website;
  # every call after the key goes to the API as usual.
  module Wallet
    module_function

    # Opens an account and a stablecoin top-up of +usd+ dollars ($10 to
    # $500: it is a new account's first week). Returns "claimCode", "amount" (the exact token amount, to six
    # decimals), "networks" (an "address" on each and its "tokens") and "payBy".
    def open_account(usd, accept_terms:, auth_url: nil, timeout: 30)
      post(auth_url, "/api/wallet/topups", { "usd" => usd, "acceptTerms" => accept_terms }, timeout)
    end

    # Once the top-up is paid, {"status" => "paid", "apiKey" => ...}, once.
    # Before that, the top-up's "status"; call again.
    def claim_account(claim_code, auth_url: nil, timeout: 30)
      post(auth_url, "/api/wallet/claim", { "claimCode" => claim_code }, timeout)
    end

    def origin(auth_url)
      value = auth_url.to_s.empty? ? ENV["RUNTIME_AUTH_URL"].to_s : auth_url
      (value.empty? ? "https://withruntime.com" : value).chomp("/")
    end

    # One POST, never redirected, with no Authorization header.
    def post(auth_url, path, body, timeout)
      base = origin(auth_url)
      uri = URI("#{base}#{path}")
      http = Net::HTTP.new(uri.host, uri.port, nil)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = http.read_timeout = http.write_timeout = timeout
      request = Net::HTTP::Post.new(uri.request_uri, "Content-Type" => "application/json")
      request.body = JSON.generate(body)
      answer = begin
        http.start { |connection| connection.request(request) }
      rescue *Transport::NETWORK_ERRORS
        raise Error.new("No answer from #{base}.", code: "network", hint: "Retry in a minute.")
      end
      said = begin
        JSON.parse(answer.body.to_s)
      rescue JSON::ParserError
        nil
      end
      said = {} unless said.is_a?(Hash)
      status = answer.code.to_i
      return said if status.between?(200, 299)

      raise Error.new(said["error"].is_a?(String) ? said["error"] : "The request failed (HTTP #{status}).",
                      code: said["code"].is_a?(String) ? said["code"] : (status == 429 ? "rate_limited" : "request_failed"),
                      status: status)
    end
    private_class_method :origin, :post
  end
end
