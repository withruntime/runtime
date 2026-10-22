# Source: https://modal.com/docs/guide/sandbox-snapshots (https://modal.com/docs/guide/sandbox-snapshots.md),
# code blocks 14, 15, 16 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Consecutive blocks of one section, which continue each other, joined in order.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

image = modal.Image.debian_slim().apt_install("curl", "procps")
app = modal.App.lookup("sandbox-snapshot", create_if_missing=True)

with modal.enable_output():
    sb = modal.Sandbox.create(
        "python3", "-m", "http.server", "8000",
        app=app, image=image, _experimental_enable_snapshot=True
    )

print(f"Performing snapshot of {sb.object_id} ...")
snapshot = sb._experimental_snapshot()

print(f"Restoring from snapshot {sb.object_id} ...")
sb2 = modal.Sandbox._experimental_from_snapshot(snapshot)

print("Let's see that the http.server is still running...")
p = sb2.exec("ps", "aux")
print(p.stdout.read())

# Talk to snapshotted Sandbox http.server
p = sb2.exec("curl", "http://localhost:8000/")
reply = p.stdout.read()
print(reply)  # <!DOCTYPE HTML><html lang...

snapshot_id = snapshot.object_id
# ... save the Sandbox ID (sb-123abc) for later
# sometime in the future...
snapshot = modal.SandboxSnapshot.from_id(snapshot_id)
sandbox = modal.Sandbox._experimental_from_snapshot(snapshot)
