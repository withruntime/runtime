# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 17 (python fixture:sb_app), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

sb = modal.Sandbox.create(
    "bash", "-c", "sleep 5 && touch /tmp/ready && sleep 3600",
    readiness_probe=modal.Probe.with_exec(
        "sh", "-c", "test -f /tmp/ready",
        interval_ms=250,
    ),
    app=sb_app,
)

# Blocks until "test -f /tmp/ready" exits with code 0
sb.wait_until_ready()

# The sandbox is now ready
p = sb.exec("cat", "/tmp/ready")
sb.terminate()
