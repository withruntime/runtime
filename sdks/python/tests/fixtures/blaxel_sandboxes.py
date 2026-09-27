# Blaxel's README (Python SDK 0.4.11): "Sandboxes", copied unmodified from
# https://github.com/blaxel-ai/sdk-python/blob/8015ae82fa6a9f0d0d929a9614a6bbe1b584dd77/README.md
# scripts/dropin_e2e.py runs it on Runtime with only the import changed.
import asyncio
from blaxel.core import SandboxInstance

async def main():

    # Create a new sandbox
    sandbox = await SandboxInstance.create_if_not_exists({
        "name": "my-sandbox",
        "image": "blaxel/base-image:latest",
        "memory": 4096,
        "region": "us-pdx-1",
        "ports": [{"target": 3000, "protocol": "HTTP"}],
        "labels": {"env": "dev", "project": "my-project"},
        "ttl": "24h"
    })

    # Get existing sandbox
    existing = await SandboxInstance.get("my-sandbox")

    # Delete sandbox (using class)
    await SandboxInstance.delete("my-sandbox")

    # Delete sandbox (using instance)
    await existing.delete()

if __name__ == "__main__":
    asyncio.run(main())
