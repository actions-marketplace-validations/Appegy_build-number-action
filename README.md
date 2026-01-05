# Build Number (Abacus) — GitHub Action

Generate **monotonic build numbers** in GitHub Actions with **separate counters per project** (or any other key).
This action is a thin wrapper around the **Abacus** counting API.

Abacus API docs: https://abacus.jasoncameron.dev/  
Abacus server source: https://github.com/JasonLovesDoggo/abacus

## What this solves

- You need a build number that is **always +1** versus the previous run.
- One CI workflow builds **multiple projects**, so you need **independent counters** per project.
- You want to **start from an existing number** (via `create` initializer, or later via admin ops).

## Supported operations

- `hit` — increment by 1 and return the new value (creates the counter if missing)
- `get` — return the current value
- `info` — return metadata (exists, TTL, etc.)
- `create` — create a counter and return `admin_key` (only returned once)
- `set` — set an exact value (**admin**)
- `update` — add a delta (can be negative) (**admin**)
- `reset` — set value to `0` (**admin**)
- `delete` — delete the counter (**admin**)

## Quick start

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Next build number
        id: buildno
        uses: appegy/build-number-action@v1
        with:
          operation: hit
          namespace: my-org
          key: build-api

      - name: Use the build number
        run: echo "build=${{ steps.buildno.outputs.value }}"
```

---

## Inputs

| Name | Type | Default | Used by operations | Description |
|---|---|---|---|---|
| `operation` | string | `hit` | all | One of: `hit`, `create`, `get`, `info`, `set`, `update`, `reset`, `delete`. |
| `namespace` | string | — | all | Counter namespace (use a stable, unique prefix for your org/team). |
| `key` | string | — | all | Counter key (e.g. `build-api`, `build-web`, `build-worker`). |
| `initializer` | integer | `0` | `create` | Starting value for the counter. |
| `value` | integer | — | `set`, `update` | `set`: sets counter to `value`. `update`: adds `value` (can be negative). |
| `admin_key` | string | — | `set`, `update`, `reset`, `delete` | Admin key for management operations. Treat as a secret. |

---

## Outputs

| Output | Set by operations | Type | Notes |
|---|---|---|---|
| `value` | `hit`, `create`, `get`, `set`, `reset`, `update` | integer (string in Actions) | The counter value returned by Abacus. |
| `namespace` | `create` | string | Echoed namespace. |
| `key` | `create` | string | Echoed key. |
| `admin_key` | `create` | string | **Only returned once** by Abacus on create. Store it immediately. |
| `exists` | `info` | string | Boolean-ish (`true`/`false`). |
| `expires_in` | `info` | string | Seconds-ish value from Abacus. |
| `expires_str` | `info` | string | Human-readable TTL string. |
| `full_key` | `info` | string | Fully-qualified key representation. |
| `is_genuine` | `info` | string | Boolean-ish (`true`/`false`). |
| `status` | `delete` | string | Usually `ok` on success. |
| `message` | `delete` | string | Informational message from Abacus. |

---

## Usage

### 1) Bootstrap the `admin_key` (one-time)

`admin_key` is returned **only once** by `create`. Save it immediately.  
If you lose it, **admin operations** (`set`, `update`, `reset`, `delete`) for that counter become permanently unavailable.

Example workflow that creates a counter and uploads the admin key as an artifact:

```yaml
name: bootstrap-abacus-admin-key

on:
  workflow_dispatch:
    inputs:
      namespace:
        description: "Abacus namespace"
        required: true
        default: "my-org"
      key:
        description: "Counter key"
        required: true
        default: "build-api"
      initializer:
        description: "Starting value"
        required: false
        default: "0"

jobs:
  bootstrap:
    runs-on: ubuntu-latest
    steps:
      - name: Create counter (admin_key is returned once)
        id: create
        uses: appegy/build-number-action@v1
        with:
          operation: create
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}
          initializer: ${{ inputs.initializer }}

      - name: Write admin key to file
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p abacus
          cat > abacus/abacus-admin-key.txt << 'EOF'
          namespace=${{ inputs.namespace }}
          key=${{ inputs.key }}
          admin_key=${{ steps.create.outputs.admin_key }}
          EOF

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: abacus-admin-key-${{ inputs.namespace }}-${{ inputs.key }}
          path: abacus/abacus-admin-key.txt
          if-no-files-found: error
          retention-days: 1
```

After you retrieve the value, store it as a repository secret (for example `ABACUS_ADMIN_KEY`) and delete the artifact.

### 2) Use the operations (excluding `create`)

Prerequisite:
- add a repository secret named `ABACUS_ADMIN_KEY` that matches this `(namespace, key)` counter.

This workflow demonstrates all operations except `create`:

```yaml
name: abacus-operations-demo

on:
  workflow_dispatch:
    inputs:
      namespace:
        description: "Abacus namespace"
        required: true
        default: "my-org"
      key:
        description: "Counter key"
        required: true
        default: "build-api"
      do_delete:
        description: "Also delete the counter at the end"
        required: false
        default: "false"

jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - name: Increment (+1)
        id: hit
        uses: appegy/build-number-action@v1
        with:
          operation: hit
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}

      - name: Read current value
        id: get
        uses: appegy/build-number-action@v1
        with:
          operation: get
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}

      - name: Get metadata
        id: info
        uses: appegy/build-number-action@v1
        with:
          operation: info
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}

      - name: Set exact value (admin)
        id: set
        uses: appegy/build-number-action@v1
        with:
          operation: set
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}
          value: 1000
          admin_key: ${{ secrets.ABACUS_ADMIN_KEY }}

      - name: Update by delta (admin)
        id: update
        uses: appegy/build-number-action@v1
        with:
          operation: update
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}
          value: -10
          admin_key: ${{ secrets.ABACUS_ADMIN_KEY }}

      - name: Reset to 0 (admin)
        id: reset
        uses: appegy/build-number-action@v1
        with:
          operation: reset
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}
          admin_key: ${{ secrets.ABACUS_ADMIN_KEY }}

      - name: Delete counter (admin)
        if: ${{ inputs.do_delete == 'true' }}
        uses: appegy/build-number-action@v1
        with:
          operation: delete
          namespace: ${{ inputs.namespace }}
          key: ${{ inputs.key }}
          admin_key: ${{ secrets.ABACUS_ADMIN_KEY }}
```

---

## Notes

- `hit` consumes a number immediately. If your job fails later, that number is still consumed.
- For multi-project CI, use different `key` values (e.g. `build-api`, `build-web`) to keep counters independent.
- If you delete a counter, you must `create` it again, and the new counter will have a **new** `admin_key`.

## Attribution

- Publisher/maintainer: Appegy (Ivan Murashka).
- Backend: Abacus counting API by Jason Cameron (see server source link above).
