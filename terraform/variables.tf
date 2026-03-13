variable "proxmox_api_url" {
  description = "Base URL of the Proxmox API (https://<host>:8006/api2/json)."
  type        = string

  validation {
    condition     = length(trimspace(var.proxmox_api_url)) > 0
    error_message = "proxmox_api_url must be set to the Proxmox API endpoint."
  }
}

variable "proxmox_api_token_id" {
  description = "API token ID (e.g. terraform@pve!labfactory) for token-based authentication."
  type        = string
  default     = ""

  validation {
    condition     = length(trimspace(var.proxmox_api_token_id)) > 0
    error_message = "proxmox_api_token_id must be set."
  }
}

variable "proxmox_api_token_secret" {
  description = "API token secret corresponding to proxmox_api_token_id."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = length(trimspace(var.proxmox_api_token_secret)) > 0
    error_message = "proxmox_api_token_secret must be set."
  }
}

variable "proxmox_tls_insecure" {
  description = "Allow insecure TLS if the Proxmox endpoint uses a self-signed certificate."
  type        = bool
  default     = true
}

variable "proxmox_node" {
  description = "Proxmox node on which the VM should be created."
  type        = string

  validation {
    condition     = length(trimspace(var.proxmox_node)) > 0
    error_message = "proxmox_node must not be empty."
  }
}

variable "vm_id" {
  description = "Unique VMID (e.g. 150) that does not yet exist on the cluster."
  type        = number
}

variable "vm_name" {
  description = "DNS-safe name for the VM."
  type        = string

  validation {
    condition     = length(trimspace(var.vm_name)) > 0
    error_message = "vm_name must not be empty."
  }
}

variable "vm_template_name" {
  description = "Name of the Proxmox template (or VM) that will be cloned."
  type        = string

  validation {
    condition     = length(trimspace(var.vm_template_name)) > 0
    error_message = "vm_template_name must not be empty."
  }
}

variable "vm_definitions" {
  description = "Optional list of VMs to create for a lab blueprint deployment."
  type = list(object({
    vmid         = number
    name         = string
    clone_source = string
    full_clone   = bool
    vlan_tag     = number
  }))
  default = []
}

variable "vm_full_clone" {
  description = "Whether the clone should be a full copy."
  type        = bool
  default     = false
}

variable "vm_cores" {
  description = "Number of virtual CPU cores."
  type        = number
  default     = 2
}

variable "vm_sockets" {
  description = "Number of CPU sockets."
  type        = number
  default     = 1
}

variable "vm_memory" {
  description = "Memory in MiB."
  type        = number
  default     = 2048
}

variable "vm_onboot" {
  description = "Whether the VM should start when the host boots."
  type        = bool
  default     = false
}

variable "vm_pool" {
  description = "Optional pool to add the VM to. Leave empty to skip."
  type        = string
  default     = ""
}

variable "vm_description" {
  description = "Human-readable description stored on the VM."
  type        = string
  default     = "Empty VM created by the LabFactory Terraform playbook."
}

variable "vm_scsi_hw" {
  description = "SCSI controller type."
  type        = string
  default     = "virtio-scsi-pci"
}

variable "network_bridge" {
  description = "Bridge the VM should attach to."
  type        = string
  default     = "vmbr0"
}

variable "network_model" {
  description = "Virtual NIC model."
  type        = string
  default     = "virtio"
}

variable "network_firewall" {
  description = "Enable Proxmox firewall on the guest NIC."
  type        = bool
  default     = false
}

variable "network_vlan_tag" {
  description = "VLAN tag applied to the NIC (0 = none)."
  type        = number
  default     = 0
}
