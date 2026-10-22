# Source: https://modal.com/docs/guide/sandbox-snapshots (https://modal.com/docs/guide/sandbox-snapshots.md),
# code block 5 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

app = modal.App.lookup("sandbox-fork-example", create_if_missing=True)

sb = modal.Sandbox.create(app=app)
p = sb.exec("bash", "-c", "pip install numpy && echo 'setup done' > /status")
p.wait()

image = sb.snapshot_filesystem()
sb.terminate()

# Start multiple Sandboxes from the same snapshot
sb2 = modal.Sandbox.create(image=image, app=app)
sb3 = modal.Sandbox.create(image=image, app=app)

# Each fork starts from the snapshotted state
assert sb2.exec("cat", "/status").stdout.read().strip() == "setup done"
assert sb3.exec("cat", "/status").stdout.read().strip() == "setup done"
