# terraform_wait.tf
# Terraform resource waiting for Cloudbase-Init completion via WinRM

resource "terraform_data" "wait_for_cloudbase_init" {
  triggers_replace = [
    proxmox_virtual_environment_vm.winvm.id
  ]

  connection {
    type     = "winrm"
    host     = proxmox_virtual_environment_vm.winvm.ipv4_addresses[0][0]
    user     = "Administrator"
    password = var.admin_password
    port     = 5985
    https    = false
    insecure = true
    timeout  = "30m"
  }

  provisioner "remote-exec" {
    inline = [
      "powershell -NoProfile -NonInteractive -Command \"while (-not (Test-Path 'C:\\ProgramData\\cloudbase-init\\done.flag')) { Start-Sleep -Seconds 5 }\""
    ]
  }
}