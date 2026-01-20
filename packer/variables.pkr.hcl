/**
 * Packer Variables for Agent VM Image
 *
 * Variables for building the multitool-agent VM image.
 * Override via CLI: packer build -var="project_id=my-project" ...
 */

variable "project_id" {
  type        = string
  description = "GCP project ID"
  default     = "multitool-workflow-web"
}

variable "zone" {
  type        = string
  description = "GCE zone for building the image"
  default     = "eu-west3-a"
}

variable "build_timestamp" {
  type        = string
  description = "Timestamp for unique image naming (e.g., BUILD_ID from Cloud Build)"
  default     = ""
}

variable "git_sha" {
  type        = string
  description = "Git SHA for provenance tracking"
  default     = "unknown"
}

variable "build_id" {
  type        = string
  description = "Cloud Build ID for provenance tracking"
  default     = "local"
}
