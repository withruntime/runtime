"""Funding is retained on sync/async network results, and reflected in public types."""
import asyncio
import unittest
from withruntime._sync_products.network_products import Addresses, Tunnel, AddressResult, TunnelResult
from withruntime._async_products.network_products import AsyncAddresses, AsyncTunnel

VALUE = {"id":"reservation", "funded":False,"fundedUntil":"2026-09-24T00:00:00.000Z","rateMicros":5000000,"rateUnit":"unit_month"}
class SyncTransport:
    def json(self, method, path, **kwargs):
        return {"data":[VALUE]} if path == '/v1/addresses' and method == 'GET' else VALUE
class AsyncTransport:
    async def json(self, method, path, **kwargs):
        return SyncTransport().json(method,path,**kwargs)
class Funding(unittest.TestCase):
    def test_sync_and_types(self):
        self.assertEqual(Addresses(SyncTransport()).reserve(),VALUE)
        self.assertEqual(Addresses(SyncTransport()).list(),[VALUE])
        self.assertEqual(Tunnel(SyncTransport()).get(),VALUE)
        for kind in [AddressResult,TunnelResult]:
            for field in ['funded','fundedUntil','rateMicros','rateUnit']:
                self.assertIn(field,kind.__annotations__)
    def test_async(self):
        async def run():
            self.assertEqual(await AsyncAddresses(AsyncTransport()).reserve(),VALUE)
            self.assertEqual(await AsyncAddresses(AsyncTransport()).list(),[VALUE])
            self.assertEqual(await AsyncTunnel(AsyncTransport()).get(),VALUE)
        asyncio.run(run())
if __name__=='__main__': unittest.main()
