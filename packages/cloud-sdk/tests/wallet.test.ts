import { expect, test } from "bun:test";
import { claimWalletAccount, openWalletAccount } from "../src/wallet";

/* openWalletAccount and claimWalletAccount against a stub website. */

test("they post to the website with no key, and a refusal becomes a RuntimeError", async () => {
  const seen: { url: string; body: unknown; auth: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      body: JSON.parse(await request.text()),
      auth: request.headers.get("authorization"),
    });
    if (request.url.endsWith("/claim"))
      return Response.json({ error: "That claim code opens no account." }, { status: 404 });
    return Response.json({ claimCode: "rtclaim_x", amount: "20.000000" }, { status: 201 });
  }) as typeof fetch;
  const options = { authUrl: "https://web.example.test", fetch: fetcher };
  const opened = await openWalletAccount({ usd: 20, acceptTerms: true }, options);
  expect(opened.claimCode).toBe("rtclaim_x");
  await expect(claimWalletAccount("rtclaim_nope", options)).rejects.toMatchObject({
    status: 404,
    message: "That claim code opens no account.",
  });
  expect(seen).toEqual([
    {
      url: "https://web.example.test/api/wallet/topups",
      body: { usd: 20, acceptTerms: true },
      auth: null,
    },
    {
      url: "https://web.example.test/api/wallet/claim",
      body: { claimCode: "rtclaim_nope" },
      auth: null,
    },
  ]);
});
