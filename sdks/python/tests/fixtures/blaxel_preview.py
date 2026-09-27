# Blaxel's README (Python SDK 0.4.11): "Preview URLs", copied unmodified from
# https://github.com/blaxel-ai/sdk-python/blob/8015ae82fa6a9f0d0d929a9614a6bbe1b584dd77/README.md
# scripts/dropin_e2e.py runs it on Runtime with only the import changed.
import asyncio
from blaxel.core import SandboxInstance

async def main():

    # Get existing sandbox
    sandbox = await SandboxInstance.get("my-sandbox")

    # Start a web server in the sandbox
    await sandbox.process.exec({
        "command": "python -m http.server 3000",
        "working_dir": "/app",
        "wait_for_ports": [3000]
    })

    # Create a public preview URL
    preview = await sandbox.previews.create_if_not_exists({
        "metadata": {"name": "app-preview"},
        "spec": {
            "port": 3000,
            "public": True
        }
    })

    print(preview.spec.url)  # https://xyz.preview.bl.run

if __name__ == "__main__":
    asyncio.run(main())
