# TTC Infrastructure

Terraform configuration for the AWS side of Talk to Claude.

## What This Creates

```
Internet (Twilio)
       |
       v
API Gateway (HTTP, public)
       |
       v
VPC Link -> NLB (internal, private subnets)
                    |
                    v
              Site-to-site VPN
                    |
                    v
            On-prem TTC server (192.168.x.x:3333)
```

**Resources created:**
- API Gateway (HTTP API) — public endpoint for Twilio webhooks
- VPC Link — connects API Gateway to the private NLB
- Network Load Balancer (internal) — routes to on-prem server via VPN
- Target Group — points at on-prem server IP
- Security Group — scoped egress to on-prem server only
- CloudWatch Log Group — API Gateway access logs

**Resources NOT created (prerequisites):**
- VPC, subnets, VPN — you bring your own
- Bedrock VPC endpoint — create separately or add to this config
- Twilio account — external service

## Usage

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your VPC, subnet, and server details

terraform init
terraform plan
terraform apply
```

After apply, Terraform outputs the webhook URL:

```
webhook_twiml_url = "https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/twiml"
```

Set this as your Twilio voice webhook URL, or pass it to the TTC server as `TTC_PUBLIC_URL`.

## Cost

| Resource | Estimated Cost |
|----------|---------------|
| API Gateway | $1/million requests (~free at low volume) |
| NLB | ~$16/month + data processing |
| CloudWatch Logs | ~$0.50/GB ingested |
| **Total** | **~$17/month baseline** |

## Security

- The VPC has no internet gateway — fully private
- API Gateway is the only public endpoint
- Twilio webhook signature validation happens at the application layer (HMAC-SHA1)
- VPC Link security group restricts egress to the on-prem server IP and port only
- API Gateway access logs capture all requests for audit
