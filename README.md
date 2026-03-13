# LabFactory

LabFactory is a Proxmox lab orchestration dashboard built around:
- reusable VM models
- drag-and-drop blueprints
- classroom-based deployments
- BullMQ job queues
- Terraform workers for deploy, start, stop, and destroy operations

The UI is served by the `dashboard` service, state is stored in PostgreSQL, and workflow execution is handled by Redis-backed workers.

## Stack
- `dashboard`: Express server + static UI
- `postgres`: persistent storage for models, blueprints, classrooms, and deployments
- `redis`: BullMQ backend
- `terraform-worker`: executes Terraform and Proxmox lifecycle actions
- `ansible-worker`: reserved for Ansible workflows

Current Docker services are defined in [docker-compose.yml](./docker-compose.yml).

## Main Features

### VM Models
VM models are stored in PostgreSQL and include:
- name
- description
- OS
  - `Windows 11`
  - `Windows Server`
  - `Ubuntu`
  - `Other`
- Proxmox template VMID
- clone mode
  - `full clone`
  - `linked clone`

The UI exposes OS selection with logos and uses the selected OS in the model cards and blueprint palette.

### Blueprints
Blueprints are created with drag and drop:
- drag VM models from the palette
- create one or more VM instances
- rename each instance
- save, reload, and delete blueprints

Each blueprint stores a reusable lab definition in PostgreSQL.

### Classrooms
Classrooms are used as deployment targets and include:
- name
- workstation count
- starting VLAN

For a classroom deployment:
- each workstation gets its own VLAN
- VLAN = `startingVlan + workstationIndex`

### Lifecycle
Lifecycle works with prepared deployments:
1. choose a blueprint
2. choose a classroom
3. click `Prepare`
4. launch actions from the deployment row

Supported actions:
- deploy
- start
- stop
- destroy

Each prepared deployment is stored independently, so multiple labs can target the same classroom.

For a classroom deployment, the blueprint is replicated for every workstation in the classroom.

VM naming convention:
- `<blueprint-name>-<two-digit-workstation-number>-<instance-name>`

Example:
- `soc-lab-01-dc`
- `soc-lab-01-client`
- `soc-lab-02-dc`

### Lifecycle State Refresh
The `Settings` page contains a `Refresh labs state` button.

This action queries Proxmox and reconciles deployment state with the real VM state:
- `running`
- `stopped`
- `destroyed`
- `mixed`

If a deployment is in a mixed state, the `Lifecycle` page shows:
- both `Start` and `Stop` icons
- a warning badge

### Jobs
The `Jobs` page provides:
- queue counters for Terraform and Ansible
- worker status
- one-line job history with:
  - queue
  - status
  - associated lab
  - action
  - duration
  - creation time
  - detail / error

The `Settings` page also contains a `Clear job history` button to remove completed and failed jobs from BullMQ history.

## Terraform Behavior
Terraform is used for deployment and destruction.

Important points:
- Proxmox authentication is done with API token environment variables
- LabFactory stores template VMIDs in the database
- before deploy, the Terraform worker resolves template VMID -> Proxmox VM name
- each deployment uses its own Terraform workspace
- deployment state is tracked in PostgreSQL

`start` and `stop` do not run Terraform apply; they call the Proxmox API directly on the deployed VMIDs.

## Data Model
Main SQL migrations:
- [001-init.sql](./db/migrations/001-init.sql)
- [002-blueprints.sql](./db/migrations/002-blueprints.sql)
- [003-lifecycle.sql](./db/migrations/003-lifecycle.sql)
- [004-classrooms.sql](./db/migrations/004-classrooms.sql)
- [005-lab-deployments.sql](./db/migrations/005-lab-deployments.sql)
- [006-template-os-type.sql](./db/migrations/006-template-os-type.sql)

The dashboard keeps track of applied migrations with `schema_migrations`.

## Repository Layout
- [dashboard/](./dashboard): UI and API server
- [workers/](./workers): BullMQ workers
- [terraform/](./terraform): Terraform Proxmox module
- [config/](./config): runtime configuration files
- [db/migrations/](./db/migrations): PostgreSQL schema and seed data

## Environment
Copy `.env.example` to `.env` and set at least:
- `PROXMOX_API_URL`
- `PROXMOX_NODE`
- `PROXMOX_TLS_INSECURE`
- `PROXMOX_API_TOKEN_ID`
- `PROXMOX_API_TOKEN_SECRET`

## Run
1. Install dependencies:

```bash
npm install
```

2. Start the stack:

```bash
docker compose up --build
```

3. Open:

```text
http://localhost:8080
```

## Notes
- PostgreSQL stores VM models, blueprints, classrooms, and prepared deployments.
- Redis stores BullMQ queue data.
- `config/terraform-settings.json` is still mounted and available, but the old settings form is no longer used for operational parameters.
- The old `terraform-validator` service has been removed from the stack.

## Cleanup
- Stop containers:

```bash
docker compose down
```

- Stop containers and delete volumes:

```bash
docker compose down -v
```

- If you need to reset local Terraform cache/state used by the worker, remove:
  - `terraform/.terraform`
  - `terraform/.terraform-vars.json`
  - any local `terraform.tfstate*` artifacts if present
