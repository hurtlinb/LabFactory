output "vm_resource_id" {
  description = "Terraform-managed Proxmox resource identifier."
  value       = proxmox_vm_qemu.blank_vm.id
}

output "vmid" {
  description = "Numeric VMID assigned in Proxmox."
  value       = proxmox_vm_qemu.blank_vm.vmid
}

output "vm_node" {
  description = "Proxmox node hosting the VM."
  value       = proxmox_vm_qemu.blank_vm.target_node
}

output "vm_name" {
  description = "Name of the deployed VM."
  value       = proxmox_vm_qemu.blank_vm.name
}
