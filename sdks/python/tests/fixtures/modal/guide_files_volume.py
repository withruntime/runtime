# Source: https://modal.com/docs/guide/sandbox-files (https://modal.com/docs/guide/sandbox-files.md),
# code block 10 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

# Find or create a Volume with the name "my-volume".
vol = modal.Volume.from_name("my-volume", create_if_missing=True)
sb = modal.Sandbox.create(
    volumes={"/cache": vol},
    app=my_app,
)
# Read a file in the Volume.
p = sb.exec("bash", "-c", "cat /cache/some-file.txt")
print(p.stdout.read())
p.wait()

# Write a file to the Volume.
p = sb.exec("bash", "-c", "echo foo > /cache/a.txt")
p.wait()
sb.terminate(wait=True)

# Access the Volume file from outside the Sandbox.
for data in vol.read_file("a.txt"):
    print(data)
