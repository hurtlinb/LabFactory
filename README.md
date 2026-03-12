# Labourator Demo

This project splits the Terraform and Ansible workers into separate container services while providing a single LabFactory dashboard for orchestration visibility.

## Prerequisites
- Terraform 1.5+ and Ansible (built into the Dockerfile).
- Node.js 20+ for the Node scripts.
- Redis for BullMQ job queues (`docker-compose.yml` provides it).

## Structure
1. `workers/terraformWorker.js` and `workers/ansibleWorker.js` run BullMQ jobs for each workflow.
2. `workers/startTerraformWorkerService.js` and `workers/startAnsibleWorkerService.js` launch the workers, publish heartbeat/status to `worker:<name>` in Redis, and listen to `control:<name>` channels for pause/resume commands.
3. `lib/jobMonitor.js` contains `waitForJobCompletion`, which polls job state instead of relying on `QueueEvents`.
4. `docker-compose.yml` runs four services: `redis`, `terraform-worker`, `ansible-worker`, and `dashboard`. The workers run continuously and the dashboard presents the LabFactory observatory UI.
5. `terraform/` now includes a Proxmox playbook that deploys an empty QEMU VM onto an existing cluster.

## Terraform playbook
The configuration under `terraform/` uses the Telmate Proxmox provider to create a minimal VM with a blank boot disk. It is intentionally opinionated (single NIC on `vmbr0`, `virtio-scsi-pci`, etc.) but every option is configurable through variables.

### Usage
1. Copy `.env.example` to `.env` and set `PROXMOX_API_URL`, `PROXMOX_NODE`, `PROXMOX_TLS_INSECURE`, `PROXMOX_API_TOKEN_ID`, and `PROXMOX_API_TOKEN_SECRET` (password logins no longer work).
2. Copy `config/terraform-settings.sample.json` to `config/terraform-settings.json` and set non-secret runtime defaults (VM sizing/network/template).
3. `cd terraform`
4. `terraform init`
5. `terraform plan -var-file=terraform.tfvars`
6. `terraform apply -var-file=terraform.tfvars`

### Notes
- Authentication now requires an API token (`PROXMOX_API_TOKEN_ID`/`PROXMOX_API_TOKEN_SECRET` in `.env`); password-based login is no longer supported.
- Keep `vm_id` unique on the cluster; Proxmox rejects duplicates.
- The playbook assumes `vmbr0` and the configured storage pool exist. Adjust `network_bridge` and disk variables if your topology differs.
- TLS verification is controlled via `.env` (`PROXMOX_TLS_INSECURE=true|false`); many lab clusters use self-signed certificates, so this is often set to `true`.
- Use the Telmate provider `3.0.2-rc07`; the 3.0 RC series ships the fixes that align with Proxmox 9.1’s ACL model and the latest release notes list rc07 as a compatible version. citeturn0search3
- API tokens still need cluster privileges such as `Sys.Audit` (and the VM/Datastore rights you want to manage) because the RC provider now queries the user list and Proxmox 9 dropped the `VM.Monitor` privilege in favor of `Sys.Audit`. citeturn1search1
- VM deployments now clone an existing Proxmox template (`vm_template_name`, managed through Administration → Paramètres). The template defines disks, NICs, cloud-init data, and CPU flavor, and Terraform performs a linked clone by default (`vm_full_clone = false`); flip the `Full clone` checkbox if you need an independent copy of the template’s storage.
- Terraform workers load `config/terraform-settings.json` for non-secret defaults, and inject Proxmox connection/auth values (`PROXMOX_API_URL`, `PROXMOX_NODE`, `PROXMOX_TLS_INSECURE`, token vars) from environment variables at runtime.
- Each run also writes a sanitized copy to `terraform/.terraform-vars.json`, ensuring Terraform only sees the variables declared in the module; replay the Administration → Paramètres save if you ever see “undeclared variable” warnings, and the worker still filters out stray fields at runtime.
- Terraform state lives in `terraform/` and is ignored by git (`.gitignore` already excludes it). Delete the `.terraform/` directory and `terraform.tfstate*` files if you need a clean slate.
- The dashboard and terraform-worker containers mount the host `config/` directory, so anything you save in Administration -> Parametres (`config/terraform-settings.json`) survives container restarts for non-secret VM defaults. 

## Running the dashboard
1. `npm install` (to generate `package-lock.json` and install dependencies).
2. `docker compose up --build terraform-worker ansible-worker dashboard` to start Redis, the workers, and the dashboard.
3. Open <http://localhost:8080>; the LabFactory sidebar exposes Design, Lifecycle, and Administration (with a Queues submenu). Within **Administration > Queues** you can monitor the BullMQ queue lengths, see worker states, issue pause/resume commands, and hit “Create a Terraform job” to enqueue a brand new workflow without additional CLI commands.

## Cleanup
- `docker compose down` removes all containers and networks.
- Remove any Terraform artifacts in `terraform/.terraform` or the `tfplan` file if needed.

This skeleton is ready to host the API, the HTTP Terraform backend, RBAC auditing, and more complex orchestration flows.


