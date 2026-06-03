#!/usr/bin/env bash
set -euo pipefail

echo "[terraform-runner] Initializing workspace for execution ${EXECUTION_ID}"
WORKSPACE="/workspace/${EXECUTION_ID}"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

echo "[terraform-runner] Fetching workspace for ${REPOSITORY}@${GIT_REF} (TODO: git clone)"
# TODO: clone repository into workspace, checkout ${GIT_REF}, read terraform config

if [ "${EXECUTION_TYPE}" = "terraform_plan" ]; then
  echo "[terraform-runner] Running terraform plan (TODO: terraform init && terraform plan)"
else
  echo "[terraform-runner] Running terraform apply (TODO: terraform apply)"
fi

echo "[terraform-runner] Streaming logs out via stdout/stderr (TODO)"
echo "[terraform-runner] Publishing artefact references (TODO: call artifact backend)"

exit 0
