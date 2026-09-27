# Blaxel's README (Python SDK 0.4.11): "Filesystem operations", copied unmodified from
# https://github.com/blaxel-ai/sdk-python/blob/8015ae82fa6a9f0d0d929a9614a6bbe1b584dd77/README.md
# scripts/dropin_e2e.py runs it on Runtime with only the import changed.
import asyncio
from blaxel.core import SandboxInstance

async def main():

    # Get existing sandbox
    sandbox = await SandboxInstance.get("my-sandbox")

    # Write and read text files
    await sandbox.fs.write("/app/config.json", '{"key": "value"}')
    content = await sandbox.fs.read("/app/config.json")

    # Write and read binary files
    with open("./image.png", "rb") as f:
        binary_data = f.read()
    await sandbox.fs.write_binary("/app/image.png", binary_data)
    blob = await sandbox.fs.read_binary("/app/image.png")

    # Create directories
    await sandbox.fs.mkdir("/app/uploads")

    # List files
    listing = await sandbox.fs.ls("/app")
    subdirectories = listing.subdirectories
    files = listing.files

    # Search for text within files
    matches = await sandbox.fs.grep("pattern", "/app", case_sensitive=True, context_lines=2, max_results=5, file_pattern="*.py", exclude_dirs=["__pycache__"])

    # Find files and directories matching specified patterns
    results = await sandbox.fs.find("/app", type="file", patterns=["*.md", "*.html"], max_results=1000)

    # Watch for file changes
    def on_change(event):
        print(event.op, event.path)

    handle = sandbox.fs.watch("/app", on_change, {
        "with_content": True,
        "ignore": ["node_modules", ".git"]
    })

    # Close watcher
    handle["close"]()

if __name__ == "__main__":
    asyncio.run(main())
