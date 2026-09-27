# Blaxel's README (Python SDK 0.4.11): "Process execution", copied unmodified from
# https://github.com/blaxel-ai/sdk-python/blob/8015ae82fa6a9f0d0d929a9614a6bbe1b584dd77/README.md
# scripts/dropin_e2e.py runs it on Runtime with only the import changed.
import asyncio
from blaxel.core import SandboxInstance

async def main():

    # Get existing sandbox
    sandbox = await SandboxInstance.get("my-sandbox")

    # Execute a command
    process = await sandbox.process.exec({
        "name": "build-process",
        "command": "npm run build",
        "working_dir": "/app",
        "wait_for_completion": True,
        "timeout": 60000  # 60 seconds
    })

    # Kill a running process
    await sandbox.process.kill("build-process")

if __name__ == "__main__":
    asyncio.run(main())
