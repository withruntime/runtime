# Storage and backups

Checked off-server copies of snapshots and volume backups survive the loss of
the server they were made on, and your own buckets mount inside a sandbox
without it ever holding their keys. A snapshot starts copying off its server
once its final compressed form is ready; `backedUp: true` confirms that copy is ready. A volume is
backed up off its server every day, and whenever you ask, and can be restored
onto any server in its region. Every copy is encrypted with a key that belongs
to your organization alone.

## What is kept where

| What                  | Where it runs          | Copy off the server                                        |
| --------------------- | ---------------------- | ---------------------------------------------------------- |
| A sandbox's own disk  | Its server             | None. Keep what you cannot rebuild on a volume             |
| A volume              | One server, fixed size | A backup every day, and on request, kept 7 days unless set |
| A snapshot            | Its source's server    | Copied once after compression, and kept as long as it is   |
| A fork's own snapshot | Its source's server    | None: it is deleted when the fork ends                     |

`backedUp` on a volume or a snapshot is `true` once its copy has been written
off the server, read back and checked. Until then it is `false`.

In your account, [Volumes](https://withruntime.com/account/volumes) lists each
volume with how full it is, the sandbox it is attached to and its backups, and
lets you create a volume, back it up now, change its backup policy, restore
a backup as a new volume, or delete a volume or backup. You can attach a
volume when creating a new sandbox. Spending and deletion ask for
confirmation using the console agent's existing permissions. Growth and
shared-volume attachment controls appear only when the deployed API offers
those guarded features; they are disabled by default.

## Growing a volume when enabled

Volume growth is disabled by default and appears in the API reference and
MCP tool list only after it is enabled. Where offered, it grows an ordinary
volume on its current server while the volume is detached; shrinking and
shared volumes are refused.

Use `runtime volume resize <id> --size-mib <N>`,
`runtime.volumes.resize(id, { sizeMiB })` in JavaScript, or
`runtime.volumes.resize(volume_id, size_mib)` in Python. The volume stays
`ready`, while `resize.state` tracks `pending`, `running`, `completed` or
`failed`. Poll the volume if the request returns before completion. Attachments
and deletion wait while the operation is active.

The old disk and confirmed size remain until the grown copy has been checked.
The larger size is billed only after completion, at the volume's existing
rate. A failure keeps the old confirmed size and records the error.

## Shared volumes when enabled

Shared volumes are disabled by default. Where the deployed API offers them,
`shared: true` at volume creation lets several sandboxes read and write the
same volume. The mode stays fixed; restoring a backup preserves its source
volume's mode rather than converting it.

Attach through `runtime volume attach <volume> <sandbox> --path /data`, and
follow the returned attachment's `attaching`, `active`, `detaching` or
`detached` state. `runtime volume attachment <volume> <attachment>` reads the
saved receipt, and `runtime volume detach <volume> <attachment>` requests a
detach. A request that stops waiting does not cancel the saved operation.
If a detach is busy, the mount remains and the receipt records the error;
free the mount before trying again.

## Volume backups

A backup is a point-in-time copy of a volume, taken while sandboxes may be
writing to it. It holds everything the volume held at that moment, the way a
disk does after a power cut: what a program had not yet written to the disk is
not in it. Stop or flush writes first when you need a clean point.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const volume = await runtime.volumes.create({ sizeMiB: 10_240, name: "data" });
const backup = await runtime.volumes.backup(volume.id, { retentionDays: 30 });
const restored = await runtime.volumes.restore(backup.id, { name: "data-restored" });
for await (const each of await runtime.volumes.backups({ volumeId: volume.id }))
  console.log(each.id);
await runtime.volumes.setBackupPolicy(volume.id, { daily: true, retentionDays: 14 });
```

```python check
from withruntime import Runtime

runtime = Runtime()
volume = runtime.volumes.create(10_240, name="data")
backup = runtime.volumes.backup(volume["id"], retention_days=30)
restored = runtime.volumes.restore(backup["id"], name="data-restored")
runtime.volumes.set_backup_policy(volume["id"], daily=True, retention_days=14)
```

```bash no-run
runtime volume backup "${vol}" --retention-days 30   # prints the backup id
runtime volume backups "${vol}"                      # newest first
runtime volume restore "${backup}" --name data-restored
runtime volume backup-policy "${vol}" --daily on --retention-days 14
runtime volume backup-rm "${backup}"
```

- **Daily:** every volume is backed up once a day, starting an hour after it is
  created. Turn that off with `daily: false`. Each daily backup is kept for the
  volume's `retentionDays`, 7 unless you set 1 to 365.
- **On request:** `backup` makes one now and waits up to a minute for it to be
  ready. A backup can be kept for 1 to 365 days.
- **Restoring:** a restore is a new volume, the size of the backup, in the same
  region, on whichever server has room. It is ready once every byte has been
  downloaded and checked; `restoredFrom` names the backup. The original volume
  is untouched.
- **Incremental:** only what changed since an earlier backup of the same
  volume is stored again, and empty space is not stored at all.
- **Deleting a volume** keeps its backups until each one's retention ends, so
  you can still restore it. Deleting a backup removes its copy.
- **If a volume's server is lost,** the volume is gone with it, and its error
  names the newest backup to restore it from.
- **Stopping a sandbox** has it write out what it wrote to its volumes first,
  and a stop that waits answers once its volumes are free to attach again. A
  sandbox whose lease runs out does the same: its programs are frozen just
  before the lease ends, and what they wrote to its volumes, and to a
  persistent sandbox's own disk, is written out after that at no charge.

## Snapshots survive their server

On hosts where deferred compression has been qualified and enabled, a
memory snapshot can be `ready` and startable on its server while
`compressionPending: true`: capture has finished, and Runtime is preparing its
final compressed form in the background. Temporary raw files are Runtime
overhead, not charged storage. The final verified compressed allocation is
used for storage billing from the snapshot's ready time, within the existing
prepaid bounds.

Its encrypted off-server copy is queued only after compression finishes.
While compression is pending, `meteredBytes` is zero, `backedUp` is false and
`durability.state` is `none`. `backedUp: true` means the off-server copy has
been checked. `durability.state` says where that stands:

| `durability.state` | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `pending`          | Being copied off the server                                                  |
| `durable`          | Copied, read back and checked; `backedUp` is `true`                          |
| `restoring`        | Its server was lost, and it is being restored onto another from its copy     |
| `failed`           | It could not be copied; `error` says why                                     |
| `none`             | A temporary fork snapshot, or capture waiting for compression before copying |

If a snapshot's server is lost, the snapshot is restored from its copy onto a
server in its region with a compatible processor. Memory snapshots resume the
saved machine there; disk snapshots boot fresh from the saved root filesystem. While that happens, a create or fork from it
answers `snapshot_restoring` (503); try again in a few minutes. If no such
server has room yet, the snapshot stays copied off the server and its `error`
says it is waiting; it is restored as soon as one does. A snapshot whose server
was lost before it was copied is deleted, its `error` says why, and it is not
charged after the server's last sign of life.

## Wake or fork on another server when enabled

Cross-server wake and fork transfers are disabled by default and require
operator qualification. Ordinary wakes and copies stay on the source server.
On a qualified deployment with transfers enabled, placement may choose a
healthy compatible server in the same region when the source cannot fit the
wake or copy. Saved processor, kernel and device compatibility, image and
volume placement, and private-placement choices still constrain that move.

Transfer workspaces and replicas are Runtime overhead, not an extra customer
charge. Uncertain outcomes keep the source data and reserved capacity until
handover or cleanup is verified. A capture awaiting compression cannot be
exported for transfer; same-server starts can still use that raw capture.
This capability does not change when an off-server backup is considered
checked: `backedUp` remains the authority for that protection.

## Updating the default image

An existing paused sandbox or snapshot keeps the filesystem saved with its
memory. Updating Runtime's default image does not replace those files. A wake
or fork preserves that identity when its trusted saved state agrees and the
kernel and machine remain compatible. New sandboxes use the current default.
An incompatible or unverifiable saved image is refused rather than silently
restarted without its memory.

## Mount your own bucket

A bucket in Amazon S3, Cloudflare R2 or Google Cloud Storage, or any
S3-compatible store, appears as a directory in a running sandbox. **The
sandbox never holds the bucket's key.** You store the key once as a secret;
the sandbox's mount client signs its requests with a placeholder, and
Runtime's egress proxy signs each request again with the real key as it leaves
for the bucket's endpoint.

```bash no-run
printf %s "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" | runtime secrets set DATA_BUCKET \
  --host s3.eu-west-1.amazonaws.com --header Authorization --format 'AWS4-HMAC-SHA256 {value}'
runtime sandbox mount "${id}" s3://my-data/datasets /data --secret DATA_BUCKET --region eu-west-1
runtime sandbox mounts "${id}"
runtime sandbox unmount "${id}" /data
```

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.mounts.add({
  provider: "s3",
  bucket: "my-data",
  region: "eu-west-1",
  path: "/data",
  secret: "DATA_BUCKET",
});
await sbx.exec("ls /data");
```

- **The secret:** its value is `ACCESS_KEY_ID:SECRET_ACCESS_KEY` (or
  `...:SESSION_TOKEN` for temporary keys), its header `Authorization`, its
  format exactly `AWS4-HMAC-SHA256 {value}`, and its hosts the bucket's
  endpoint: `s3.<region>.amazonaws.com` for S3,
  `<account id>.r2.cloudflarestorage.com` for R2, `storage.googleapis.com` for
  Google Cloud Storage (with an HMAC key), or your store's own host.
- **Providers:** `s3` with `region` (us-east-1 when omitted) or `endpoint` for
  another S3-compatible store, `r2` with `accountId`, `gcs`. A `prefix` mounts
  only the keys under it, and `readOnly` mounts it read-only. A public bucket
  needs no secret.
- **What it is:** rclone, installed in the sandbox the first time you mount,
  which takes a few seconds more. Files are written to the bucket when they are
  closed. Two sandboxes can mount the same bucket; a file two of them write is
  the last one closed.
- **How long:** a mount lasts through a pause and a wake, and ends when the
  sandbox stops; mount it again after a restart.
- **Network:** the bucket is reached over HTTPS through the sandbox's own
  network rules, like any other host.

## Encryption and deletion

- Each organization has its own data key. Everything a copy puts in the object
  store is encrypted with it, and the names of the stored pieces reveal nothing
  about their content. Nothing is shared or compared across organizations.
- Every piece is checked when it is read back: a copy that does not match what
  was written is refused rather than restored.
- When an organization is deleted, its key is destroyed first, which makes every
  copy it had unreadable at once, and then the copies themselves are deleted.

## Limits and price

- Up to 200 volume backups per organization at a time.
- Backups and restores run at a lower priority than your sandboxes. A backup is
  `pending` until it is copied and checked, and a restored volume is `creating`
  until every byte is downloaded and checked.
- Snapshot copies are part of the snapshot and its [price](./pricing).
- Volume backups cost {{backup-rate}} per decimal GB per 30-day month, charged on
  `storedBytes` once the copy is ready. See [pricing](./pricing).
