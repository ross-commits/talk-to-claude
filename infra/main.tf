###############################################################################
# Talk to Claude (TTC) — AWS Infrastructure
#
# Routes Twilio webhooks from the internet to an on-premises server via:
#   API Gateway (HTTP) -> VPC Link -> NLB (internal) -> VPN -> on-prem server
#
# No internet gateway or NAT gateway required in the VPC.
# The VPC stays fully private; only API Gateway is public-facing.
#
# Prerequisites:
#   - Existing VPC with site-to-site VPN to on-prem network
#   - VPN routes configured for the on-prem CIDR
#   - Bedrock VPC endpoint (for Nova Sonic)
###############################################################################

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

###############################################################################
# Data sources — look up existing infrastructure
###############################################################################

data "aws_vpc" "this" {
  id = var.vpc_id
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }

  filter {
    name   = "subnet-id"
    values = var.private_subnet_ids
  }
}

###############################################################################
# NLB — Internal, routes to on-prem server via VPN
###############################################################################

resource "aws_lb" "ttc" {
  name               = "${var.project}-nlb"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.private_subnet_ids

  enable_cross_zone_load_balancing = true

  tags = local.tags
}

resource "aws_lb_target_group" "ttc" {
  name        = "${var.project}-tg"
  port        = var.onprem_server_port
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    protocol            = "HTTP"
    path                = "/health"
    port                = tostring(var.onprem_server_port)
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 30
  }

  tags = local.tags
}

resource "aws_lb_target_group_attachment" "onprem" {
  target_group_arn  = aws_lb_target_group.ttc.arn
  target_id         = var.onprem_server_ip
  port              = var.onprem_server_port
  availability_zone = "all" # Cross-zone: target is outside the VPC (on-prem via VPN)
}

resource "aws_lb_listener" "ttc" {
  load_balancer_arn = aws_lb.ttc.arn
  port              = var.onprem_server_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ttc.arn
  }

  tags = local.tags
}

###############################################################################
# API Gateway (HTTP API) — Public-facing, routes to NLB via VPC Link
###############################################################################

resource "aws_apigatewayv2_vpc_link" "ttc" {
  name               = "${var.project}-vpc-link"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [aws_security_group.vpc_link.id]

  tags = local.tags
}

resource "aws_apigatewayv2_api" "ttc" {
  name          = "${var.project}-webhook-api"
  protocol_type = "HTTP"
  description   = "TTC webhook ingress — routes Twilio webhooks to on-prem server via VPN"

  tags = local.tags
}

resource "aws_apigatewayv2_integration" "ttc" {
  api_id             = aws_apigatewayv2_api.ttc.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = aws_lb_listener.ttc.arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.ttc.id

  payload_format_version = "1.0"
}

# Catch-all route: proxy everything to the on-prem server
resource "aws_apigatewayv2_route" "catch_all" {
  api_id    = aws_apigatewayv2_api.ttc.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.ttc.id}"
}

# Root route (for health checks)
resource "aws_apigatewayv2_route" "root" {
  api_id    = aws_apigatewayv2_api.ttc.id
  route_key = "ANY /"
  target    = "integrations/${aws_apigatewayv2_integration.ttc.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.ttc.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  tags = local.tags
}

###############################################################################
# Security Group — VPC Link ENIs
###############################################################################

resource "aws_security_group" "vpc_link" {
  name_prefix = "${var.project}-vpc-link-"
  vpc_id      = var.vpc_id
  description = "TTC API Gateway VPC Link — allows traffic to on-prem server"

  # Outbound to on-prem server via VPN
  egress {
    description = "To on-prem TTC server"
    from_port   = var.onprem_server_port
    to_port     = var.onprem_server_port
    protocol    = "tcp"
    cidr_blocks = ["${var.onprem_server_ip}/32"]
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

###############################################################################
# CloudWatch — API Gateway access logs
###############################################################################

resource "aws_cloudwatch_log_group" "api_gw" {
  name              = "/aws/apigateway/${var.project}-webhook-api"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

###############################################################################
# Locals
###############################################################################

locals {
  tags = {
    Project   = var.project
    ManagedBy = "terraform"
  }
}
