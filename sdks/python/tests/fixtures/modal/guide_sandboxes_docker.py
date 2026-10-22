# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 32 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

image = (
    modal.Image.from_registry("ubuntu:24.04")
    .env({"DEBIAN_FRONTEND": "noninteractive"})
    .apt_install("docker.io")
)

sb = modal.Sandbox.create(
    "dockerd",
    app=sb_app,
    image=image,
    runtime="vm",
    readiness_probe=modal.Probe.with_exec("docker", "info", interval_ms=500),
)
sb.wait_until_ready()

p = sb.exec("docker", "run", "--rm", "alpine", "echo", "hello from Docker")
p.wait()
print(p.stdout.read())

sb.terminate()
