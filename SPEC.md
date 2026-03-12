# Infrastructure Execution Orchestrator

## Overview

This project implements an **execution orchestrator** for infrastructure
automation tasks using **Terraform** and **Ansible**.

The system exposes an API that allows users to request infrastructure
executions. Executions are scheduled, validated against concurrency
rules, and executed as **ephemeral Kubernetes Jobs**.

The platform provides:

-   execution orchestration
-   concurrency control
-   locking by environment or resource
-   isolated infrastructure execution
-   execution logs
-   execution lifecycle tracking
-   future support for approval workflows (Terraform plan → apply)

The system is **not a generic background job queue**. It is an
**infrastructure automation orchestrator**.

------------------------------------------------------------------------

# High Level Architecture

                    +---------------------+
                    |        Client       |
                    |   CLI / UI / API    |
                    +----------+----------+
                               |
                               v
                        +------+------+\
                        |     API     |
                        |  Node.js    |
                        +------+------+\
                               |
                               v
                        +------+------+\
                        |  PostgreSQL |
                        |  executions |
                        +------+------+\
                               |
                               v
                        +------+------+\
                        |   BullMQ    |
                        |    Redis    |
                        +------+------+\
                               |
                               v
                        +------+------+\
                        |  Scheduler  |
                        +------+------+\
                               |
                               v
                        +------+------+\
                        |  Launcher   |
                        +------+------+\
                               |
                               v
                   +-----------------------+
                   | Kubernetes Job Runner |
                   +----------+------------+
                              |
                +-------------+-------------+
                |                           |
       +--------+--------+         +--------+--------+
       | Terraform Runner |        | Ansible Runner  |
       +------------------+        +-----------------+

------------------------------------------------------------------------

# Core Components

## API

The API is responsible for:

-   accepting execution requests
-   validating input
-   persisting execution metadata
-   pushing jobs into the queue
-   exposing execution status and logs

The API **must never execute Terraform or Ansible directly**.

Execution is asynchronous.

### Endpoints

    POST /executions
    GET  /executions/:id
    GET  /executions/:id/logs
    POST /executions/:id/cancel

### Execution creation

The API must:

1.  validate the request
2.  persist the execution
3.  push a minimal message to the queue
4.  return `202 Accepted`

------------------------------------------------------------------------

# Execution Lifecycle

Possible execution states:

    queued
    scheduled
    preparing
    running
    succeeded
    failed
    cancelled

Execution lifecycle:

    API request
        ↓
    queued
        ↓
    scheduler validates
        ↓
    scheduled
        ↓
    launcher creates Kubernetes Job
        ↓
    preparing
        ↓
    running
        ↓
    succeeded / failed

------------------------------------------------------------------------

# Scheduler

The scheduler consumes jobs from the queue and determines whether they
may start.

Responsibilities:

-   enforce execution locks
-   enforce concurrency limits
-   apply scheduling rules
-   forward authorized executions to the launcher

Example rules:

-   only one `terraform apply` per environment
-   limit ansible executions per inventory
-   prevent concurrent operations on same infrastructure

Locking logic must be implemented in a **dedicated service**.

------------------------------------------------------------------------

# Launcher

The launcher is responsible for creating Kubernetes Jobs.

Responsibilities:

-   receive scheduled execution
-   select runner image
-   create Kubernetes Job
-   attach metadata labels
-   monitor Job lifecycle
-   update execution status

Example labels:

    execution-id
    project
    environment
    execution-type

The launcher must interact with Kubernetes through a **dedicated
infrastructure adapter**.

------------------------------------------------------------------------

# Runners

Each execution runs inside an isolated Kubernetes Job.

Two runner images must exist.

------------------------------------------------------------------------

## Terraform Runner

Responsibilities:

-   prepare temporary workspace
-   clone repository
-   checkout specific git ref
-   load variables
-   run terraform commands

Supported execution types:

    terraform_plan
    terraform_apply

Example commands:

    terraform init
    terraform plan
    terraform apply

Artifacts produced:

-   terraform plan
-   logs
-   outputs

Terraform state must rely on a **remote backend**.

------------------------------------------------------------------------

## Ansible Runner

Responsibilities:

-   prepare temporary workspace
-   clone repository
-   load inventory
-   execute ansible playbook

Example command:

    ansible-playbook site.yml

Artifacts produced:

-   execution logs
-   result summary

------------------------------------------------------------------------

# Data Model

## Execution

    Execution
    ---------
    id
    type
    status
    requestedBy
    project
    environment
    target
    lockKey
    repository
    gitRef
    payload
    exitCode
    errorSummary
    startedAt
    finishedAt
    createdAt
    updatedAt

Types:

    terraform_plan
    terraform_apply
    ansible_run

------------------------------------------------------------------------

## ExecutionLog

    ExecutionLog
    ------------
    id
    executionId
    timestamp
    stream
    message

Streams:

    stdout
    stderr
    system

------------------------------------------------------------------------

## ExecutionArtifact

    ExecutionArtifact
    -----------------
    id
    executionId
    kind
    uri
    createdAt

------------------------------------------------------------------------

# Repository Structure

    src
     ├─ api
     │   ├─ controllers
     │   ├─ routes
     │   └─ server.ts
     │
     ├─ application
     │   ├─ execution-service
     │   ├─ scheduler-service
     │   └─ lock-service
     │
     ├─ domain
     │   ├─ execution
     │   └─ logs
     │
     ├─ infrastructure
     │   ├─ db
     │   ├─ queue
     │   ├─ k8s
     │   ├─ secrets
     │   └─ artifacts
     │
     ├─ workers
     │   ├─ scheduler
     │   └─ launcher
     │
    runners
     ├─ terraform
     │   ├─ Dockerfile
     │   └─ entrypoint.sh
     │
     └─ ansible
         ├─ Dockerfile
         └─ entrypoint.sh

    docker
    k8s
    README.md
    SPEC.md

------------------------------------------------------------------------

# Kubernetes Design

## Long-lived components

Run as Deployments:

    api
    scheduler
    launcher

------------------------------------------------------------------------

## Ephemeral components

Run as Jobs:

    terraform runner
    ansible runner

Each execution must run in its own Pod.

Benefits:

-   resource isolation
-   fault containment
-   clear observability
-   easier cleanup

------------------------------------------------------------------------

# Security Requirements

Mandatory rules:

-   secrets must never appear in logs
-   secrets must never be stored in Redis
-   jobs must only receive secret references
-   execution containers must run with minimal privileges

Future integration expected with:

    Vault
    AWS Secrets Manager
    Azure Key Vault

------------------------------------------------------------------------

# Terraform Specific Rules

Terraform requires strict locking.

The system must prevent:

    terraform apply on same workspace concurrently

Recommended lock key:

    <project>:<environment>:terraform

Plan and apply must eventually support a **human approval step**.

------------------------------------------------------------------------

# Ansible Specific Rules

Ansible must avoid conflicting runs on same targets.

Recommended lock key:

    <inventory>:<target-group>

------------------------------------------------------------------------

# Logging

Execution logs must be:

-   streamed from runners
-   persisted
-   queryable by execution id

Logs must distinguish:

    stdout
    stderr
    system

------------------------------------------------------------------------

# Observability

Future improvements should include:

-   metrics
-   execution duration tracking
-   failure rate monitoring
-   structured logs

------------------------------------------------------------------------

# Local Development

Local development should run using:

    docker compose

Services:

    postgres
    redis
    api
    scheduler
    launcher

Runners may be executed locally for testing.

------------------------------------------------------------------------

# MVP Scope

The MVP must include:

-   API
-   execution persistence
-   BullMQ integration
-   scheduler
-   launcher
-   Kubernetes Job creation
-   Terraform runner skeleton
-   Ansible runner skeleton

------------------------------------------------------------------------

# Out of Scope (MVP)

Not required initially:

-   full RBAC
-   approval workflows
-   full artifact storage backend
-   advanced secret management
-   UI

------------------------------------------------------------------------

# Development Workflow

Implementation steps:

1.  inspect repository
2.  create data models
3.  implement API
4.  implement queue
5.  implement scheduler
6.  implement launcher
7.  implement runners
8.  add Kubernetes manifests
9.  add documentation

------------------------------------------------------------------------

# Definition of Done

The system must be able to:

1.  receive an execution request
2.  persist it
3.  queue it
4.  schedule it
5.  launch a Kubernetes Job
6.  execute Terraform or Ansible
7.  update execution status
8.  store logs

------------------------------------------------------------------------

# Future Extensions

Planned improvements:

-   approval workflow
-   RBAC
-   UI
-   execution replay
-   multi-cluster execution
-   advanced scheduling
-   artifact storage
-   secret management integration
