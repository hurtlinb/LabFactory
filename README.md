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
   For Windows 11 FR: Cloudbase-Init must run with the built-in `Administrateur` account, not `admin`.

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
