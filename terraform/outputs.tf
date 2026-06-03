output "vm_resource_ids" {
  description = "Terraform-managed Proxmox resource identifiers keyed by VMID."
  value       = { for key, vm in proxmox_vm_qemu.lab_vm : key => vm.id }
}

output "vmids" {
  description = "Numeric VMIDs assigned in Proxmox."
  value       = { for key, vm in proxmox_vm_qemu.lab_vm : key => vm.vmid }
}

output "vm_nodes" {
  description = "Proxmox node hosting each VM."
  value       = { for key, vm in proxmox_vm_qemu.lab_vm : key => vm.target_node }
}

output "vm_names" {
  description = "Names of deployed VMs keyed by VMID."
  value       = { for key, vm in proxmox_vm_qemu.lab_vm : key => vm.name }
}
