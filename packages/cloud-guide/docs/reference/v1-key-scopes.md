# Keys from Runtime 1.0

A key made on Runtime 1.0 keeps working on 2.0, with the same secret, and can do exactly what it could do on 1.0, never more. Each of its scopes becomes the v2 permissions below: the actions of the v1 calls that scope allowed. A scope whose calls 2.0 does not serve becomes no permission. A key with a scope this page does not list is not moved: its organization stays on 1.0 until the key is replaced.

| 1.0 scope | v2 permissions | v1 calls it allowed |
| --- | --- | --- |
| `*` | Every permission of the key's person, or of an owner for an agent's key | Every call |
| `read:*` | `sandboxes:get`, `sandboxes:list`, `sandboxes:read`, `secrets:list`, `secrets:get`, `jobs:get`, `jobs:list`, `jobRuns:list`, `jobRuns:get`, `jobRuns:read`, `snapshots:list`, `snapshots:get`, `images:get`, `images:list`, `images:read`, `volumes:list`, `me:get`, `usage:get`, `usage:list`, `previews:list`, `previews:get`, `domains:get` | Every call of `list`, `get`, `usage`, `read_file`, `notices`, `secrets_list`, `secrets_get`, `jobs_list`, `jobs_get`, `services_list`, `services_get` |
| `create` | `sandboxes:create`, `sandboxes:wake`, `sandboxes:network`, `sandboxes:fork`, `sandboxes:snapshot`, `sandboxes:update`, `images:write`, `images:create`, `domains:create`, `ports:create` | `POST /v1/sandboxes`, `POST /v1/sandboxes/{id}:wake`, `PUT /v1/sandboxes/{id}/network`, `POST /v1/sandboxes/{id}:fork`, `POST /v1/sandboxes/{id}:snapshot`, `POST /v1/sandboxes/{id}:update`, `POST /v1/images/context/missing`, `PUT /v1/images/context/{digest}`, `POST /v1/images`, `POST /v1/domains`, `POST /v1/domains/{hostname}:verify`, `POST /v1/ports` |
| `list` | `sandboxes:list`, `snapshots:list`, `images:list`, `volumes:list` | `GET /v1/sandboxes`, `GET /v1/snapshots`, `GET /v1/images`, `GET /v1/volumes` |
| `get` | `sandboxes:get`, `snapshots:get`, `images:get`, `images:read`, `previews:list`, `previews:get`, `domains:get` | `GET /v1/sandboxes/{id}`, `GET /v1/sandboxes/{id}/network`, `GET /v1/sandboxes/{id}/metrics`, `GET /v1/snapshots/{id}`, `GET /v1/images/{id}`, `GET /v1/images/resolve`, `GET /v1/images/{id}/logs`, `GET /v1/sandboxes/{id}/previews`, `GET /v1/sandboxes/{id}/previews/{port}`, `GET /v1/domains/{hostname}` |
| `stop` | `sandboxes:delete`, `sandboxes:pause`, `snapshots:delete`, `images:delete`, `domains:delete`, `ports:delete` | `DELETE /v1/sandboxes/{id}`, `POST /v1/sandboxes/{id}:pause`, `POST /v1/snapshots/{id}:delete`, `POST /v1/images/{id}:delete`, `DELETE /v1/domains/{hostname}`, `DELETE /v1/ports/{id}` |
| `usage` | `me:get`, `usage:get`, `usage:list` | `GET /v1/me`, `GET /v1/usage`, `GET /v1/limits`, `GET /v1/usage/export` |
| `exec` | `sandboxes:exec`, `sessions:create`, `sessions:delete`, `previews:create`, `previews:sign`, `previews:delete` | `POST /v1/sandboxes/{id}:exec`, `POST /v1/sandboxes/{id}/processes`, `GET /v1/sandboxes/{id}/processes/{process}/output`, `GET /v1/sandboxes/{id}/processes/{process}`, `POST /v1/sandboxes/{id}/processes/{process}:write`, `POST /v1/sandboxes/{id}/processes/{process}:signal`, `POST /v1/sandboxes/{id}/processes/{process}:resize`, `GET /v1/sandboxes/{id}/processes`, `GET /v1/sandboxes/{id}/desktop/screenshot`, `POST /v1/sandboxes/{id}/desktop:act`, `POST /v1/sandboxes/{id}/interpreter:run`, `POST /v1/sandboxes/{machineId}/sessions`, `POST /v1/sandboxes/{sandbox}/sessions/{id}:revoke`, `POST /v1/sandboxes/{id}/previews`, `GET /v1/sandboxes/{id}/previews/{port}`, `POST /v1/sandboxes/{id}/previews/{port}:rotate`, `DELETE /v1/sandboxes/{id}/previews/{port}` |
| `read_file` | `sandboxes:read` | `GET /v1/sandboxes/{id}/files/content`, `GET /v1/sandboxes/{id}/files/stat`, `GET /v1/sandboxes/{id}/files/list`, `GET /v1/sandboxes/{id}/files/archive`, `POST /v1/sandboxes/{id}/files:link` |
| `write_file` | `sandboxes:write` | `PUT /v1/sandboxes/{id}/files/content`, `POST /v1/sandboxes/{id}/uploads`, `PUT /v1/sandboxes/{id}/uploads/{upload}`, `POST /v1/sandboxes/{id}/files:remove`, `PUT /v1/sandboxes/{id}/files/archive`, `POST /v1/sandboxes/{id}/files/archive/uploads`, `PUT /v1/sandboxes/{id}/files/archive/uploads/{upload}`, `POST /v1/sandboxes/{id}/files/archive/uploads/{upload}:commit`, `POST /v1/sandboxes/{id}/files/archive/uploads/{upload}:abort`, `POST /v1/sandboxes/{id}/files:mkdir`, `POST /v1/sandboxes/{id}/files:rename`, `POST /v1/sandboxes/{id}/uploads/{upload}:commit`, `POST /v1/sandboxes/{id}/files:revoke-links` |
| `notices` | None | None that 2.0 serves |
| `secrets_list` | `secrets:list` | `GET /v1/egress-secrets` |
| `secrets_get` | `secrets:get` | `GET /v1/egress-secrets/{name}` |
| `secrets_write` | `secrets:write` | `PUT /v1/egress-secrets/{name}`, `PUT /v1/egress-secrets/{name}/rules`, `PUT /v1/egress-secrets/{name}/sandboxes` |
| `secrets_reveal` | None | None that 2.0 serves |
| `secrets_use` | None | None that 2.0 serves |
| `secrets_delete` | `secrets:delete` | `DELETE /v1/egress-secrets/{name}` |
| `jobs_list` | `jobs:list` | `GET /v1/jobs` |
| `jobs_get` | `jobs:get`, `jobRuns:list`, `jobRuns:get`, `jobRuns:read` | `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/runs`, `GET /v1/job-runs/{id}`, `GET /v1/job-runs/{id}/logs` |
| `jobs_write` | `jobs:create`, `jobs:pause`, `jobs:wake`, `jobs:update` | `POST /v1/jobs`, `POST /v1/jobs/{id}:pause`, `POST /v1/jobs/{id}:resume`, `POST /v1/jobs/{id}:update`, `POST /v1/jobs/{id}:reschedule` |
| `jobs_cancel` | `jobs:delete` | `POST /v1/jobs/{id}:cancel` |
| `jobs_run` | `jobs:exec` | `POST /v1/jobs/{id}:trigger` |
| `services_create` | None | None that 2.0 serves |
| `services_list` | None | None that 2.0 serves |
| `services_get` | None | None that 2.0 serves |
| `services_stop` | None | None that 2.0 serves |
