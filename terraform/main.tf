terraform {
  required_version = ">= 1.5"

  required_providers {
    proxmox = {
      source  = "Telmate/proxmox"
      version = "3.0.2-rc07"
    }
  }
}

provider "proxmox" {
  pm_api_url          = var.proxmox_api_url
  pm_api_token_id     = var.proxmox_api_token_id
  pm_api_token_secret = var.proxmox_api_token_secret
  pm_tls_insecure     = var.proxmox_tls_insecure
}

resource "proxmox_vm_qemu" "blank_vm" {
  name        = var.vm_name
  target_node = var.proxmox_node
  vmid        = var.vm_id

  cpu {
    cores   = var.vm_cores
    sockets = var.vm_sockets
  }

  memory             = var.vm_memory
  start_at_node_boot = var.vm_onboot
  pool    = var.vm_pool == "" ? null : var.vm_pool

  clone     = var.vm_template_name
  full_clone = var.vm_full_clone

  bootdisk = "scsi0"
  scsihw   = var.vm_scsi_hw
  agent    = 1

  network {
    id       = 0
    model    = var.network_model
    bridge   = var.network_bridge
    firewall = var.network_firewall
    tag      = var.network_vlan_tag == 0 ? null : var.network_vlan_tag
  }
}
