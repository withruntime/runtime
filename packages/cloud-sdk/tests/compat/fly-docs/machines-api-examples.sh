# Fly.io's own Machines API examples, copied verbatim from Fly's docs.
# Source: github.com/superfly/docs at 15f58f1f30287c152c65c22d8124edfdab8ace3c (read 18 October 2026),
# the pages fly.io/docs/machines/api/apps-resource/ and machines-resource/.
# Only the docs' escaping is undone (\\ is rendered \ on fly.io). Each
# example is introduced by '### <section> <url>'. scripts/compatibility-fly-docs-live.ts
# runs them against Runtime with FLY_API_HOSTNAME pointed at npx withruntime fly-api,
# filling in the docs' placeholder machine ids, instance id and lease nonce.

### Create a Fly App https://fly.io/docs/machines/api/apps-resource/#create-a-fly-app
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps" \
  -d '{
      "app_name": "my-app-name",
      "org_slug": "personal",
      "network": "my-optional-network"
    }'

### Get app details https://fly.io/docs/machines/api/apps-resource/#get-app-details
curl -i -X GET \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name"

### Delete a Fly App https://fly.io/docs/machines/api/apps-resource/#delete-a-fly-app
curl -i -X DELETE \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name"

### List apps in an organization https://fly.io/docs/machines/api/apps-resource/#list-apps-in-an-organization
curl -i -X GET \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps?org_slug=personal"

### List Machines https://fly.io/docs/machines/api/machines-resource/#list-machines
curl -i -X GET \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines"

### Create a Machine https://fly.io/docs/machines/api/machines-resource/#create-a-machine
curl -i -X POST \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
  "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines" \
  -d '{
    "config": {
      "init": {
        "exec": [
          "/bin/sleep",
          "inf"
        ]
      },
      "image": "registry-1.docker.io/library/ubuntu:latest",
      "auto_destroy": true,
      "restart": {
        "policy": "always"
      },
      "guest": {
        "cpu_kind": "shared",
        "cpus": 1,
        "memory_mb": 256
      }
    }
  }'

### Create a Machine with services https://fly.io/docs/machines/api/machines-resource/#create-a-machine-with-services
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines" \
  -d '{
      "name": "my-app-name",
      "config": {
        "image": "flyio/fastify-functions",
        "env": {
          "APP_ENV": "production"
        "services": [
          {
            "ports": [
              {
                "port": 443,
                "handlers": [
                  "tls",
                  "http"
                ]
              },
              {
                "port": 80,
                "handlers": [
                  "http"
                ]
              }
            ],
            "protocol": "tcp",
            "internal_port": 8080
          }
        ],
        "checks": {
            "httpget": {
                "type": "http",
                "port": 8080,
                "method": "GET",
                "path": "/",
                "interval": "15s",
                "timeout": "10s"
                }
            }
        }
    }
}'

### Wait for a Machine to reach a specified state https://fly.io/docs/machines/api/machines-resource/#wait-for-a-machine-to-reach-a-specified-state
curl -i -X GET \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589/wait?state=stopped&instance_id=01HMVXC16ED6SHK9452AF029Y7"

### Get a Machine https://fly.io/docs/machines/api/machines-resource/#get-a-machine
curl -i -X GET \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589"

### Update a Machine https://fly.io/docs/machines/api/machines-resource/#update-a-machine
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589" \
  -d '{
      "config": {
        "image": "flyio/fastify-functions",
        "guest": {
          "memory_mb": 512,
          "cpus": 2,
          "cpu_kind": "shared"
        },
        "env": {
          "APP_ENV": "production"
        },
        "services": [
          {
            "ports": [
              {
                "port": 443,
                "handlers": [
                  "tls",
                  "http"
                ]
              },
              {
                "port": 80,
                "handlers": [
                  "http"
                ]
              }
            ],
            "protocol": "tcp",
            "internal_port": 8080
          }
        ]
      }
    }'

### Stop a Machine https://fly.io/docs/machines/api/machines-resource/#stop-a-machine
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589/stop"

### Suspend a Machine https://fly.io/docs/machines/api/machines-resource/#suspend-a-machine
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589/suspend"

### Start a Machine https://fly.io/docs/machines/api/machines-resource/#start-a-machine
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589/start"

### Delete a Machine permanently https://fly.io/docs/machines/api/machines-resource/#delete-a-machine-permanently
curl -i -X DELETE \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/24d896dec64879?force=true"

### Create a Machine lease https://fly.io/docs/machines/api/machines-resource/#create-a-machine-lease
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/3d8d413b29d089/lease" \
    -d '{
        "description": "",
        "ttl": 500
    }'

### Get a Machine lease https://fly.io/docs/machines/api/machines-resource/#get-a-machine-lease
curl -i -X GET \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/3d8d413b29d089/lease"

### Release a Machine lease https://fly.io/docs/machines/api/machines-resource/#release-a-machine-lease
curl -i -X DELETE \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" -H "fly-machine-lease-nonce: fed368b018e9" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/3d8d413b29d089/lease"

### Route requests away from or back to a Machine (1) https://fly.io/docs/machines/api/machines-resource/#route-requests-away-from-or-back-to-a-machine
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589/cordon"

### Route requests away from or back to a Machine (2) https://fly.io/docs/machines/api/machines-resource/#route-requests-away-from-or-back-to-a-machine
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/73d8d46dbee589/uncordon"

### Get a Machine’s metadata https://fly.io/docs/machines/api/machines-resource/#get-a-machines-metadata
curl -i -X GET \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/9080e339b57798/metadata"

### Add or update Machine metadata https://fly.io/docs/machines/api/machines-resource/#add-or-update-machine-metadata
curl -i -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/9080e339b57798/metadata/foo-key" \
    -d '{
        "value":"bar"
        }'

### Delete Machine metadata https://fly.io/docs/machines/api/machines-resource/#delete-machine-metadata
curl -i -X DELETE \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" -H "Content-Type: application/json" \
    "${FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/9080e339b57798/metadata/foo-key"
