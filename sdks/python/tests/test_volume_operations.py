import asyncio
import unittest
from withruntime._async_products.volumes import AsyncVolumes
from withruntime._sync_products.volumes import Volumes


class AsyncTransport:
    def __init__(self): self.calls = []
    async def json(self, method, path, **options):
        self.calls.append((method, path, options))
        return {'id': 'result'}


class SyncTransport:
    def __init__(self): self.calls = []
    def json(self, method, path, **options):
        self.calls.append((method, path, options))
        return {'id': 'result'}


class VolumeOperations(unittest.TestCase):
    def check_calls(self, calls):
        self.assertEqual(calls, [
            ('POST','/v1/volumes/v%2Fid:resize',{'body':{'sizeMiB':128},'wait':0,'idempotency_key':'resize'}),
            ('POST','/v1/volumes/v%2Fid:attach',{'body':{'sandboxId':'guest','path':'/data'},'wait':10,'idempotency_key':None}),
            ('POST','/v1/volumes/v%2Fid/attachments/a%2Fid:detach',{'body':{},'wait':12,'idempotency_key':'detach'}),
            ('GET','/v1/volumes/v%2Fid/attachments/a%2Fid',{}),
            ('POST','/v1/volumes',{'body':{'sizeMiB':64,'shared':True},'wait':10,'idempotency_key':None}),
        ])

    def test_async_operations(self):
        async def use():
            t=AsyncTransport();v=AsyncVolumes(t)
            await v.resize('v/id',128,wait=0,idempotency_key='resize')
            await v.attach('v/id','guest','/data')
            await v.detach('v/id','a/id',wait=12,idempotency_key='detach')
            await v.get_attachment('v/id','a/id')
            await v.create(64,shared=True)
            self.check_calls(t.calls)
        asyncio.run(use())

    def test_generated_sync_operations(self):
        t=SyncTransport();v=Volumes(t)
        v.resize('v/id',128,wait=0,idempotency_key='resize')
        v.attach('v/id','guest','/data')
        v.detach('v/id','a/id',wait=12,idempotency_key='detach')
        v.get_attachment('v/id','a/id')
        v.create(64,shared=True)
        self.check_calls(t.calls)


if __name__ == '__main__': unittest.main()
