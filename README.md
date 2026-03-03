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
1. Copy `terraform/terraform.tfvars.sample` to `terraform/terraform.tfvars` and fill in the API endpoint, API token ID/secret (password logins no longer work), node name, a unique `vm_id`, and the template name you want to clone.
2. `cd terraform`
3. `terraform init`
4. `terraform plan -var-file=terraform.tfvars`
5. `terraform apply -var-file=terraform.tfvars`

### Notes
- Authentication now requires an API token (`proxmox_api_token_id`/`proxmox_api_token_secret`); password-based login is no longer supported, so fill those fields in Administration → Paramètres before enqueueing jobs.
- Keep `vm_id` unique on the cluster; Proxmox rejects duplicates.
- The playbook assumes `vmbr0` and the configured storage pool exist. Adjust `network_bridge` and disk variables if your topology differs.
- TLS verification is disabled by default (`proxmox_tls_insecure = true`) because many lab clusters use self-signed certificates; flip the flag once you trust the certificate.
- Use the Telmate provider `3.0.2-rc07`; the 3.0 RC series ships the fixes that align with Proxmox 9.1’s ACL model and the latest release notes list rc07 as a compatible version. citeturn0search3
- API tokens still need cluster privileges such as `Sys.Audit` (and the VM/Datastore rights you want to manage) because the RC provider now queries the user list and Proxmox 9 dropped the `VM.Monitor` privilege in favor of `Sys.Audit`. citeturn1search1
- VM deployments now clone an existing Proxmox template (`vm_template_name`, managed through Administration → Paramètres). The template defines disks, NICs, cloud-init data, and CPU flavor, and Terraform performs a linked clone by default (`vm_full_clone = false`); flip the `Full clone` checkbox if you need an independent copy of the template’s storage.
- Terraform workers now load `config/terraform-settings.json` (populated by the dashboard Administration → Settings page) and pass it directly as `-var-file=` during each job. Failing to fill those UI fields leads to startup logs complaining about unset variables, so configure the settings page (or manually create the JSON file) before queueing jobs.
- Each run also writes a sanitized copy to `terraform/.terraform-vars.json`, ensuring Terraform only sees the variables declared in the module; replay the Administration → Paramètres save if you ever see “undeclared variable” warnings, and the worker still filters out stray fields at runtime.
- Terraform state lives in `terraform/` and is ignored by git (`.gitignore` already excludes it). Delete the `.terraform/` directory and `terraform.tfstate*` files if you need a clean slate.
- The dashboard and terraform-worker containers mount the host `config/` directory, so anything you save in Administration → Paramètres (`config/terraform-settings.json`) survives container restarts. Do not delete that file if you want the saved credentials and VM defaults to persist across `docker compose down`/`up` cycles. 

## Running the dashboard
1. `npm install` (to generate `package-lock.json` and install dependencies).
2. `docker compose up --build terraform-worker ansible-worker dashboard` to start Redis, the workers, and the dashboard.
3. Open <http://localhost:8080>; the LabFactory sidebar exposes Design, Lifecycle, and Administration (with a Queues submenu). Within **Administration > Queues** you can monitor the BullMQ queue lengths, see worker states, issue pause/resume commands, and hit “Create a Terraform job” to enqueue a brand new workflow without additional CLI commands.

## Cleanup
- `docker compose down` removes all containers and networks.
- Remove any Terraform artifacts in `terraform/.terraform` or the `tfplan` file if needed.

This skeleton is ready to host the API, the HTTP Terraform backend, RBAC auditing, and more complex orchestration flows.
