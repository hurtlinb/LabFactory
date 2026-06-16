# Changelog

All notable changes to LabFactory are documented here.

## [Unreleased]

### Added
- Reset Password button per VM via Proxmox guest agent (Linux: `chpasswd`, Windows: `Set-LocalUser`)
- CHANGELOG visible from the dashboard (icon next to version number)
- Build tag displayed in UI footer: SHA for dev, version number for prod

### Changed
- Reset IP, Reset Password and Redeploy VMs actions now use SVG icon buttons instead of text buttons
- Reset IP script overwrites the existing netplan file instead of creating a new `99-labfactory-reset.yaml`
- `terraform-settings.json` mounted via Kubernetes ConfigMap in terraform worker pod

### Fixed
- Reset IP bash script rewritten with `set -e` and semicolons to avoid broken `&&` chain when `grep` returns no matches

---

## [1.4.0] — 2026-06-12

### Added
- GitHub Actions CI/CD: push to `main` builds and deploys to dev (SHA tag); GitHub Release deploys to prod (semver tag)
- GitOps repository (`labfactory-gitops`) with Kustomize base + overlays for dev and prod
- ArgoCD Applications for dev (auto self-heal) and prod (manual sync)
- Image tags: `dashboard-<sha7>` / `worker-<sha7>` for dev, `dashboard-<version>` / `worker-<version>` for prod

### Changed
- Single `main` branch workflow — dev branch removed
- Kubernetes manifests moved out of the app repo into `labfactory-gitops`

---

## [1.3.2] — 2026-06-12

### Added
- Reset IP button per VM (only visible when deployment is running)
- IP reset via Proxmox guest agent: Linux (netplan) and Windows (PowerShell `NetIPAddress` cmdlets)
- DNS reset to Swisscom servers (`195.186.4.162`, `195.186.4.163`) on IP reset

---

## [1.3.1] — 2026-06-12

### Changed
- Conflict warning moved from prepare to deploy/start actions
- Conflict warning restricted to active labs only

---

## [1.3.0] — 2026-06-12

### Added
- Classroom conflict warning when starting a lab on an already-occupied classroom
- Owner initials pill on each lab card
- Active lab owner displayed in classroom card
