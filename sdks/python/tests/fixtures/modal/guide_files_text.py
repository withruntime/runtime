# Source: https://modal.com/docs/guide/sandbox-files (https://modal.com/docs/guide/sandbox-files.md),
# code block 1 (python), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

app = modal.App.lookup("sandbox-fs-demo", create_if_missing=True)

sb = modal.Sandbox.create(app=app)

# Write text to a file in the Sandbox.
sb.filesystem.write_text("Hello World!\n", "/tmp/test.txt")

# Read the file back from the Sandbox into a string.
contents = sb.filesystem.read_text("/tmp/test.txt")
print(contents)

sb.terminate()
