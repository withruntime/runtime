# Blaxel's documentation: "Create a sandbox", copied unmodified from
# https://github.com/blaxel-ai/docs/blob/17fb3bbe8c1a7f0e315d14559a752080933757f7/Sandboxes/Overview.mdx
# scripts/dropin_e2e.py runs it on Runtime with only the import changed.
import asyncio
from blaxel.core import SandboxInstance

async def main():

    # Create sandbox if it doesn't exist
    sandbox = await SandboxInstance.create_if_not_exists({
      "name": "my-sandbox",
      "image": "blaxel/base-image:latest",   # public or custom image
      "memory": 4096,   # in MB
      "ports": [{ "target": 3000 }],   # optional; ports to expose
      "labels": {"env": "dev", "project": "my-project"},  # optional; labels
      "region": "us-pdx-1"   # deployment region
    })

if __name__ == "__main__":
    asyncio.run(main())
