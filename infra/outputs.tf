###############################################################################
# Outputs
###############################################################################

output "webhook_url" {
  description = "Public URL for Twilio webhooks (set as TTC_PUBLIC_URL)"
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
  description = "API Gateway ID"
  value       = aws_apigatewayv2_api.ttc.id
}
