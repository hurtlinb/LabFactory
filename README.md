# LabFactory

LabFactory is a Proxmox lab orchestration dashboard built around:
- reusable VM models
- drag-and-drop blueprints
- classroom-based deployments
- BullMQ job queues
- Terraform workers for deploy, start, stop, and destroy operations

The UI is served by the `dashboard` service, state is stored in PostgreSQL, and workflow execution is handled by Redis-backed workers.

## Authentication
The dashboard can be protected with OpenID Connect through Keycloak.

When `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID` are configured:
- all dashboard pages and `/api/*` routes require authentication
- login is handled with the Authorization Code flow + PKCE
- the sidebar shows the authenticated user and a logout link

Required environment variables for OIDC:
- `SESSION_SECRET`
- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`

Optional environment variables:
- `OIDC_CLIENT_SECRET`
- `OIDC_SCOPES` (default: `openid profile email`)
- `OIDC_REDIRECT_URI`
- `OIDC_POST_LOGOUT_REDIRECT_URI`
- `SESSION_COOKIE_SECURE`
- `TRUST_PROXY`

### Authorization
Page and API access is controlled by two Keycloak **client roles** (not realm roles), created on the client identified by `OIDC_CLIENT_ID` and assigned per-user:
- `teacher` — access to the Labs pages (Dashboard, Blueprints, Labs, Courses)
- `admin` — access to everything, including Administration (Users, VM Models, Classrooms, Maintenance, Jobs)

Notes:
- Client roles are read from the access token's `resource_access.<clientId>.roles` claim. In Keycloak, the `roles` client scope must remain a **Default** (not Optional) scope on the client so this claim is included.
- A user authenticated via Keycloak but with neither role is shown a blocked "Access denied" screen, and all role-gated `/api/*` routes return `403`.
- The "Users" page shows each synchronized teacher's role as of their last blueprint/deployment activity — it does not live-sync with Keycloak, so a role change there only reflects after that user's next action.

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
Each blueprint is also linked to the teacher who created it, using the authenticated OpenID Connect user email.
Each blueprint must also be attached to a course.

### Classrooms
Classrooms are used as deployment targets and include:
- name
- workstation count
- starting VLAN

For a classroom deployment:
- each workstation gets its own VLAN
- VLAN = `startingVlan + workstationIndex`

### Courses
Courses are managed from the `Administration` section.

Each course contains:
- a unique required number
- an optional description

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
Each deployment also stores the teacher email that created it, using the authenticated OpenID Connect user email as the key.

For a classroom deployment, the blueprint is replicated for every workstation in the classroom.

VM naming convention:
- `<course-number>-<teacher-initials>-<blueprint-name>-<two-digit-workstation-number>-<instance-name>`

Example:
- `101-bh-soc-lab-01-dc`
- `101-bh-soc-lab-01-client`
- `101-bh-soc-lab-02-dc`

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

The danger zone also contains a `Clean orphaned disks` button. It uses the Proxmox API token to inspect QEMU VM configs, list volumes in `PROXMOX_ORPHANED_DISK_POOL` (`ceph-pool` by default), and remove pool volumes that are not referenced by any VM config. Volumes whose VMID still exists in Proxmox or whose RBD image still has watchers are ignored. The cleanup uses direct Proxmox REST API calls on the first node from `PROXMOX_NODES` or `PROXMOX_NODE`; the `nodes/{node}/execute` endpoint is not used because Proxmox restricts it to `root@pam`.

## Terraform Behavior
Terraform is used for deployment and destruction.

Important points:
- Proxmox authentication is done with API token environment variables
- LabFactory stores template VMIDs in the database
- before deploy, the Terraform worker resolves template VMID -> Proxmox VM name
- the Proxmox API token must have `VM.Audit` on each template VMID, for example `/vms/<template-vmid>`, so the worker can read the template name and disk layout
- each deployment uses its own Terraform workspace
- VMs are distributed round-robin across `PROXMOX_NODES`; when it is empty, the worker discovers online Proxmox nodes and falls back to `PROXMOX_NODE`
- VMs are registered in Proxmox HA only after guest readiness checks pass, using `vm_ha_state = "started"` by default; set `vm_ha_state` to an empty string to leave HA unmanaged
- Terraform and Telmate provider concurrency are controlled by `TERRAFORM_PARALLELISM` (`10` by default, capped at `64` by the worker)
- deployment state is tracked in PostgreSQL

`start` and `stop` do not run Terraform apply; they resolve each VM's current Proxmox node and call the Proxmox API directly on the deployed VMIDs. For HA-managed VMs, the worker requests the matching Proxmox HA state (`started` or `stopped`) instead of fighting the HA manager.

## Ubuntu Template Preparation
To prepare an Ubuntu VM before converting it to a Proxmox template:

1. Install Cloud-Init, the QEMU guest agent, and OpenSSH server:

```bash
sudo apt update
sudo apt install -y cloud-init qemu-guest-agent openssh-server
```

2. Enable the guest agent and SSH:

```bash
sudo systemctl enable qemu-guest-agent
sudo systemctl enable ssh
```

3. Configure Cloud-Init for Proxmox and make sure the NoCloud datasource is allowed:

```bash
sudo nano /etc/cloud/cloud.cfg.d/99-pve.cfg
```

Use:

```yaml
datasource_list: [ NoCloud, ConfigDrive ]
```

4. Clean the Cloud-Init state before turning the VM into a template:

```bash
sudo cloud-init clean --logs
```

5. Remove machine identifiers to avoid duplicate identities and network conflicts on clones:

```bash
sudo truncate -s 0 /etc/machine-id
sudo rm /var/lib/dbus/machine-id
```

6. Optionally remove existing SSH host keys so they are regenerated on first boot:

```bash
sudo rm -f /etc/ssh/ssh_host_*
```

7. Power off the VM:

```bash
sudo poweroff
```

Once the VM is powered off, convert it into a Proxmox template.

LabFactory expects Linux guest customization over SSH. The template must therefore expose an SSH server and allow login for the configured `linux_default_username`.

## Windows Template Preparation
The Windows template preparation flow is the same for Windows Server 2022 and Windows 11.

To prepare a Windows VM before converting it to a Proxmox template:

1. Install the QEMU guest agent.

2. Install Cloudbase-Init.
  # EDIT BHU: that's not true
  # For Windows 11 FR: Cloudbase-Init must run with the built-in `Administrateur` account, not `admin`.

3. Copy the files from [FilesForTemplates](./FilesForTemplates):
- `cloudbase-init.conf`
- `unattend.xml`
- any additional Windows preparation files needed by your template workflow

4. Open an elevated PowerShell session and set the execution policy to `RemoteSigned`:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine
```

5. Run `sysprep`.

6. Once the VM is powered off, convert it into a Proxmox template.

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
- `REDIS_PASSWORD`
- `PROXMOX_API_URL`
- `PROXMOX_NODE`
- `PROXMOX_TLS_INSECURE`
- `PROXMOX_API_TOKEN_ID`
- `PROXMOX_API_TOKEN_SECRET`

Optional Proxmox node distribution:
- `PROXMOX_NODES` comma-separated target nodes, for example `pve01,pve02,pve03`
- `TERRAFORM_PARALLELISM` concurrent Terraform and Telmate provider operations, for example `20` for large multi-node deployments

To enable Keycloak authentication, also set:
- `SESSION_SECRET`
- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`

Example Keycloak values:
- `OIDC_ISSUER_URL=https://keycloak.example.com/realms/labfactory`
- `OIDC_CLIENT_ID=labfactory-dashboard`
- `OIDC_CLIENT_SECRET=<only for confidential clients>`

## Redis Security
Redis is used as the BullMQ backend and is expected to run behind the internal Docker network only.

Current security model:
- Redis is not published with `ports`, so it is not exposed on the host by default
- Redis requires authentication through `REDIS_PASSWORD`
- `dashboard`, `terraform-worker`, and `ansible-worker` use the same `REDIS_PASSWORD` value

When changing the Redis password in `.env`, restart the Redis and application services:

```bash
docker compose up -d redis dashboard ansible-worker terraform-worker
```

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
- Redis should stay on the internal Docker network unless you also add network-level restrictions and secret management.
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
