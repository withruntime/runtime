# Blaxel's documentation: "List sandboxes", copied unmodified from
# https://github.com/blaxel-ai/docs/blob/17fb3bbe8c1a7f0e315d14559a752080933757f7/Sandboxes/Overview.mdx
# scripts/dropin_e2e.py runs it on Runtime with only the import changed.
import asyncio
from blaxel.core import SandboxInstance

async def main():
    sandboxes = await SandboxInstance.list(limit=50)
    async for sandbox in sandboxes.auto_paging_iter():
        print(sandbox.metadata.name)

asyncio.run(main())
