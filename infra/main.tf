###############################################################################
# Talk to Claude (TTC) — AWS Infrastructure
#
# Two traffic paths from Twilio to on-prem server:
#
#   1. HTTP webhooks (always on):
#      API Gateway (HTTP) -> VPC Link -> NLB (internal) -> VPN -> on-prem
#      No IGW required — API Gateway is natively public-facing.
#
#   2. WebSocket media streams (optional, enable_alb = true):
#      ALB (internet-facing) -> VPN -> on-prem
#      Requires public subnets with IGW and an ACM certificate.
#      Replaces ngrok for Twilio audio streaming.
#
# Prerequisites:
#   - Existing VPC with site-to-site VPN to on-prem network
#   - VPN routes configured for the on-prem CIDR
#   - Bedrock VPC endpoint (for Nova Sonic)
#   - (ALB only) Public subnets with Internet Gateway, ACM certificate
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
  description = "TTC API Gateway VPC Link - allows traffic to on-prem server"

  # Outbound to NLB and on-prem server
  egress {
    description = "To NLB and on-prem TTC server"
    from_port   = var.onprem_server_port
    to_port     = var.onprem_server_port
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.this.cidr_block, "${var.onprem_server_ip}/32"]
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
# ALB — Internet-facing, for WebSocket media streams (optional)
#
# Twilio sends audio via WebSocket (wss://), which API Gateway HTTP API
# does not support. This ALB handles WebSocket upgrade natively.
# Enable with: enable_alb = true
#
# Security layers:
#   1. WAF: Rate limiting + AWS managed rules (IP reputation, bad inputs)
#   2. SG: HTTPS-only ingress, egress locked to on-prem server IP + port
#   3. App: WebSocket token auth (256-bit, timing-safe) + Twilio HMAC-SHA1
#
# Twilio does NOT publish stable IPs for Media Streams — they explicitly
# require accepting from any public IP and validating X-Twilio-Signature.
# WAF rate limiting mitigates abuse without breaking Twilio connectivity.
###############################################################################

resource "aws_lb" "ws" {
  count = var.enable_alb ? 1 : 0

  name               = "${var.project}-alb"
  internal           = false
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb[0].id]

  tags = local.tags
}

resource "aws_lb_target_group" "ws" {
  count = var.enable_alb ? 1 : 0

  name        = "${var.project}-ws-tg"
  port        = var.onprem_server_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    protocol            = "HTTP"
    path                = "/health"
    port                = tostring(var.onprem_server_port)
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }

  # WebSocket connections are long-lived
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  tags = local.tags
}

resource "aws_lb_target_group_attachment" "ws_onprem" {
  count = var.enable_alb ? 1 : 0

  target_group_arn  = aws_lb_target_group.ws[0].arn
  target_id         = var.onprem_server_ip
  port              = var.onprem_server_port
  availability_zone = "all"
}

resource "aws_lb_listener" "ws_https" {
  count = var.enable_alb ? 1 : 0

  load_balancer_arn = aws_lb.ws[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ws[0].arn
  }

  tags = local.tags
}

# HTTP -> HTTPS redirect
resource "aws_lb_listener" "ws_http_redirect" {
  count = var.enable_alb ? 1 : 0

  load_balancer_arn = aws_lb.ws[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = local.tags
}

resource "aws_security_group" "alb" {
  count = var.enable_alb ? 1 : 0

  name_prefix = "${var.project}-alb-"
  vpc_id      = var.vpc_id
  description = "TTC ALB - allows HTTPS from internet, forwards to on-prem"

  ingress {
    description = "HTTPS from internet (Twilio WebSocket)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

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
# WAF — Rate limiting and managed rules on the ALB
###############################################################################

resource "aws_wafv2_web_acl" "alb" {
  count = var.enable_alb ? 1 : 0

  name        = "${var.project}-alb-waf"
  scope       = "REGIONAL"
  description = "TTC ALB WAF - rate limiting + managed rules"

  default_action {
    allow {}
  }

  # Rate limit: 300 requests per 5 minutes per IP (generous for WebSocket upgrade + webhooks)
  rule {
    name     = "rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 300
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules: IP reputation list (blocks known bad actors)
  rule {
    name     = "aws-ip-reputation"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules: Known bad inputs (SQLi, XSS, etc.)
  rule {
    name     = "aws-known-bad-inputs"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleGroup"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-alb-waf"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "alb" {
  count = var.enable_alb ? 1 : 0

  resource_arn = aws_lb.ws[0].arn
  web_acl_arn  = aws_wafv2_web_acl.alb[0].arn
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
