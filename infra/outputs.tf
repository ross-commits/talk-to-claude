###############################################################################
# Outputs
###############################################################################

output "webhook_url" {
  description = "Public URL for Twilio webhooks (set as TTC_WEBHOOK_URL)"
  value       = aws_apigatewayv2_api.ttc.api_endpoint
}

output "webhook_twiml_url" {
  description = "Full TwiML webhook URL to configure in Twilio"
  value       = "${aws_apigatewayv2_api.ttc.api_endpoint}/twiml"
}

output "webhook_sms_url" {
  description = "SMS webhook URL to configure in Twilio"
  value       = "${aws_apigatewayv2_api.ttc.api_endpoint}/sms"
}

output "nlb_dns" {
  description = "Internal NLB DNS name"
  value       = aws_lb.ttc.dns_name
}

output "api_gateway_id" {
  description = "API Gateway HTTP API ID"
  value       = aws_apigatewayv2_api.ttc.id
}

output "ws_url" {
  description = "WebSocket URL for Twilio media streams (set as TTC_WS_URL). Only available when enable_alb = true."
  value       = var.enable_alb ? "https://${aws_lb.ws[0].dns_name}" : null
}

output "alb_dns" {
  description = "ALB DNS name (use for CNAME record if using custom domain)"
  value       = var.enable_alb ? aws_lb.ws[0].dns_name : null
}

