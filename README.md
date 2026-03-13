# LabFactory

This project splits the Terraform and Ansible workers into separate container services while providing a single LabFactory dashboard for orchestration and blueprint design.

## Prerequisites
- Terraform 1.5+ and Ansible (built into the Dockerfile).
- Node.js 20+ for the Node scripts.
- Redis for BullMQ job queues (`docker-compose.yml` provides it).
- PostgreSQL for persistent storage of VM templates and lab blueprints (`docker-compose.yml` provides it).

## Structure
1. `workers/terraformWorker.js` and `workers/ansibleWorker.js` run BullMQ jobs for each workflow.
2. `workers/startTerraformWorkerService.js` and `workers/startAnsibleWorkerService.js` launch the workers, publish heartbeat/status to `worker:<name>` in Redis, and listen to `control:<name>` channels for pause/resume commands.
3. `lib/jobMonitor.js` contains `waitForJobCompletion`, which polls job state instead of relying on `QueueEvents`.
4. `docker-compose.yml` runs five services: `postgres`, `redis`, `terraform-worker`, `ansible-worker`, and `dashboard`.
5. `terraform/` contains the Proxmox configuration used by Terraform jobs.

## Terraform playbook
The configuration under `terraform/` uses the Telmate Proxmox provider to create VMs from an existing Proxmox template. Runtime defaults are managed from the LabFactory Settings page and saved to `config/terraform-settings.json`.

### Usage
1. Copy `.env.example` to `.env` and set `PROXMOX_API_URL`, `PROXMOX_NODE`, `PROXMOX_TLS_INSECURE`, `PROXMOX_API_TOKEN_ID`, and `PROXMOX_API_TOKEN_SECRET`.
2. `npm install`
3. `docker compose up --build dashboard terraform-worker ansible-worker`
4. Open <http://localhost:8080>

### Notes
- Authentication requires an API token (`PROXMOX_API_TOKEN_ID` and `PROXMOX_API_TOKEN_SECRET` in `.env`).
- Keep `vm_id` unique on the cluster; Proxmox rejects duplicates.
- The deployment assumes the configured bridge and storage pool already exist on the Proxmox cluster.
- VM deployments clone an existing Proxmox template (`vm_template_name`, managed through Settings). The template defines disks, NICs, cloud-init data, and CPU flavor.
- Terraform workers load `config/terraform-settings.json` for non-secret defaults, and inject Proxmox connection/auth values from environment variables at runtime.
- Each run writes a sanitized copy to `terraform/.terraform-vars.json`, ensuring Terraform only sees declared variables.
- The dashboard and terraform worker containers mount the host `config/` directory, so settings survive container restarts.

## Dashboard
The LabFactory sidebar exposes:
- `Blueprints` to create reusable VM templates and build labs with drag and drop.
- `Lifecycle` as a placeholder for future deployment flow views.
- `Settings` to edit non-secret Terraform and VM defaults.
- `Queues` to monitor BullMQ workers and enqueue Terraform jobs.

Blueprints and templates are stored in PostgreSQL and can be reopened and edited later.

## Cleanup
- `docker compose down` removes all containers and networks.
- Remove Terraform artifacts in `terraform/.terraform` or `terraform.tfstate*` if you need a clean local state.

This skeleton is ready to host the API, the HTTP Terraform backend, RBAC auditing, and more complex orchestration flows.
