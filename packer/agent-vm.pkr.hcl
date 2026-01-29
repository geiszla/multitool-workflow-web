/**
 * Packer Template for Agent VM Image
 *
 * Builds a custom VM image for multitool-workflow-web agents.
 * The image contains:
 * - Debian 12 base
 * - Node.js 24 LTS (via signed apt repo)
 * - Build tools (build-essential, python3, git, jq)
 * - Claude CLI (@anthropic-ai/claude-code)
 * - npm dependencies (node-pty, ws) pre-installed
 * - systemd service templates (disabled by default)
 *
 * User-specific configuration (credentials, repo clone) remains dynamic at runtime.
 */

packer {
  required_plugins {
    googlecompute = {
      version = ">= 1.1.0"
      source  = "github.com/hashicorp/googlecompute"
    }
  }
}

locals {
  # Generate timestamp if not provided
  timestamp = var.build_timestamp != "" ? var.build_timestamp : formatdate("YYYYMMDDhhmmss", timestamp())
}

source "googlecompute" "agent_vm" {
  project_id   = var.project_id
  zone         = var.zone

  # Source image - Debian 12
  source_image_family      = "debian-12"
  source_image_project_id = ["debian-cloud"]

  # Output image configuration
  image_name   = "multitool-agent-${local.timestamp}"
  image_family = "multitool-agent"
  image_labels = {
    managed-by   = "packer"
    git-sha      = var.git_sha
    build-id     = var.build_id
    node-version = "24"
  }

  # Build machine configuration
  machine_type = "e2-medium"
  disk_size    = 20
  disk_type    = "pd-ssd"

  # SSH configuration for provisioning
  ssh_username = "packer"

  # Network configuration - use external IP for package downloads during build
  # Production VMs use no external IP (Cloud NAT for egress)
  network = "default"
}

build {
  sources = ["source.googlecompute.agent_vm"]

  # Create destination directories for file uploads
  provisioner "shell" {
    inline = ["mkdir -p /tmp/vm-agent /tmp/multitool-workflow"]
  }

  # Upload vm-agent files to the build VM
  provisioner "file" {
    source      = "vm-agent/"
    destination = "/tmp/vm-agent"
  }

  # Upload multitool-workflow plugin to the build VM
  provisioner "file" {
    source      = "multitool-workflow/"
    destination = "/tmp/multitool-workflow"
  }

  # Run the main provisioning script
  provisioner "shell" {
    script = "packer/scripts/provision.sh"
    # Run as root for package installation
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Path }}"
  }

  # Run verification script to validate the build
  provisioner "shell" {
    script = "packer/scripts/verify.sh"
    # Run as root for system checks
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Path }}"
  }
}
