# Source: https://modal.com/docs/guide/sandbox-files (https://modal.com/docs/guide/sandbox-files.md),
# code block 4 (python), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from pathlib import Path
from withruntime import modal

# Write a local file.
with open("local-file.txt", "w") as f:
    f.write("Hello World!\n")

app = modal.App.lookup("sandbox-fs-demo", create_if_missing=True)

sb = modal.Sandbox.create(app=app)

# Copy the local file into the Sandbox.
sb.filesystem.copy_from_local("local-file.txt", "/tmp/file-in-sandbox.txt")

# Copy it back to the local filesystem.
sb.filesystem.copy_to_local("/tmp/file-in-sandbox.txt", "local-file-copy.txt")

print(Path("local-file-copy.txt").read_text())

sb.terminate()
