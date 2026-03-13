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

locals {
  vm_definitions = length(var.vm_definitions) > 0 ? var.vm_definitions : [
    {
      vmid         = var.vm_id
      name         = var.vm_name
      clone_source = var.vm_template_name
      full_clone   = var.vm_full_clone
      ip_last_octet = null
      ipconfig0    = "ip=dhcp"
      disk_type    = null
      disk_slot    = null
      disk_storage = null
      disk_size    = null
      cloudinit_slot = null
      cloudinit_storage = null
      vlan_tag     = var.network_vlan_tag
    }
  ]

  vm_definitions_by_id = {
    for vm in local.vm_definitions : tostring(vm.vmid) => vm
  }
}

resource "proxmox_vm_qemu" "lab_vm" {
  for_each = local.vm_definitions_by_id

  name        = each.value.name
  target_node = var.proxmox_node
  vmid        = each.value.vmid
  os_type     = "cloud-init"

  cpu {
    cores   = var.vm_cores
    sockets = var.vm_sockets
  }

  memory             = var.vm_memory
  start_at_node_boot = var.vm_onboot
  pool    = var.vm_pool == "" ? null : var.vm_pool

  clone      = each.value.clone_source
  full_clone = each.value.full_clone
  ipconfig0  = try(each.value.ipconfig0, "ip=dhcp")
  bios       = var.vm_bios

  scsihw = var.vm_scsi_hw
  agent = 1

  dynamic "disk" {
    for_each = try(each.value.disk_type, null) == null ? [] : [1]
    content {
      type    = each.value.disk_type
      slot    = each.value.disk_slot
      storage = each.value.disk_storage
      size    = each.value.disk_size
    }
  }

  dynamic "disk" {
    for_each = try(each.value.cloudinit_slot, null) == null ? [] : [1]
    content {
      type    = "cloudinit"
      slot    = each.value.cloudinit_slot
      storage = each.value.cloudinit_storage
    }
  }

  network {
    id       = 0
    model    = var.network_model
    bridge   = var.network_bridge
    firewall = var.network_firewall
    tag      = each.value.vlan_tag == 0 ? null : each.value.vlan_tag
  }
}
