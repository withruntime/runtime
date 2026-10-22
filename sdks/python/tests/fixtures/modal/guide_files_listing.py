# Source: https://modal.com/docs/guide/sandbox-files (https://modal.com/docs/guide/sandbox-files.md),
# code block 7 (python), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

app = modal.App.lookup("sandbox-fs-demo", create_if_missing=True)

sb = modal.Sandbox.create(app=app)

# Set up a structured project.
sb.filesystem.make_directory("/tmp/project/results")

# Let the Sandbox do some work and write outputs to files.
sb.filesystem.write_text("42\n", "/tmp/project/results/answer.txt")
sb.filesystem.write_text("debug info\n", "/tmp/project/results/debug.log")

# Inspect what was produced.
for entry in sb.filesystem.list_files("/tmp/project/results"):
    print(entry.name, entry.type.value, entry.size)

# Check that the result file has content before downloading it.
info = sb.filesystem.stat("/tmp/project/results/answer.txt")
if info.size > 0:
    answer = sb.filesystem.read_text("/tmp/project/results/answer.txt")
    print(answer)

# Clean up the whole project.
sb.filesystem.remove("/tmp/project", recursive=True)

sb.terminate()
