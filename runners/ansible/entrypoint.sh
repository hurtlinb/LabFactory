#!/usr/bin/env bash
set -euo pipefail

echo "[ansible-runner] Preparing workspace for ${EXECUTION_ID}"
WORKSPACE="/workspace/${EXECUTION_ID}"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

echo "[ansible-runner] Fetching playbooks from ${REPOSITORY}@${GIT_REF} (TODO: git clone)"
# TODO: clone repository, ensure inventory and variables are present

echo "[ansible-runner] Executing ansible-playbook (TODO: ansible-playbook ...)"
echo "[ansible-runner] Stream logs to stdout/stderr and publish artefacts (TODO)"

exit 0
