###############################################################################
# Variables
###############################################################################

variable "project" {
  description = "Project name, used as prefix for all resources"
  type        = string
  default     = "ttc"
}

variable "aws_region" {
  description = "AWS region (must have Bedrock Nova Sonic available)"
  type        = string
  default     = "us-east-1"
}

# --- Existing Infrastructure ---

variable "vpc_id" {
  description = "ID of existing VPC with site-to-site VPN"
  type        = string
}

variable "private_subnet_ids" {
  description = "IDs of private subnets in the VPC (at least 2 AZs)"
  type        = list(string)
}

# --- On-Premises Server ---

variable "onprem_server_ip" {
  description = "IP address of the on-prem TTC server (reachable via VPN)"
  type        = string
}

variable "onprem_server_port" {
  description = "Port the TTC server listens on"
  type        = number
  default     = 3333
}

# --- Optional ---

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 14
}
