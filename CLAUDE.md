# Talk to Claude (TTC)

Voice and text communication plugin for Claude Code. Fork of [ZeframLou/call-me](https://github.com/ZeframLou/call-me).

## Architecture

```
server/src/
  index.ts              # MCP server entry point (stdio transport)
  phone-call.ts         # CallManager: call lifecycle, WebSocket audio, HTTP webhooks
  claude-brain.ts       # Bedrock Converse wrapper (Claude as conversation brain)
  tools.ts              # Infrastructure tools for mid-call use (env-configured)
  ngrok.ts              # ngrok tunnel management (dev fallback)
  webhook-security.ts   # Twilio HMAC-SHA1 + Telnyx Ed25519 signature validation
  providers/
    types.ts            # Provider interfaces (PhoneProvider, TTSProvider, RealtimeSTTProvider)
    index.ts            # Provider factory (env var -> provider instances)
    phone-twilio.ts     # Twilio voice (primary)
    phone-telnyx.ts     # Telnyx voice (kept from upstream)
    tts-openai.ts       # OpenAI TTS
    stt-openai-realtime.ts  # OpenAI Realtime STT
    voice-nova-sonic.ts # AWS Nova Sonic speech-to-speech (default)
    sms-twilio.ts       # Twilio SMS/MMS
    stt-self-hosted.ts  # Self-hosted STT (faster-whisper, batch REST + client VAD)
    tts-self-hosted.ts  # Self-hosted TTS (Kokoro/MeloTTS/Piper)

infra/
  main.tf               # API Gateway + NLB -> VPN -> on-prem (replaces ngrok)
  variables.tf          # Terraform variables
  outputs.tf            # API Gateway URL output
```

## Key Patterns

- **Provider interfaces**: All services behind interfaces in `types.ts`, factory in `index.ts`
- **Env var prefix**: `TTC_` (changed from `CALLME_` in upstream)
- **Audio pipeline**: mu-law 8kHz (Twilio) <-> PCM 16kHz (Nova Sonic in) / PCM 24kHz (Nova Sonic out)
- **MCP tools**: Registered via `@modelcontextprotocol/sdk`, communicated over stdio
- **No Twilio SDK**: All Twilio API calls use raw `fetch()` to keep dependencies minimal
- **Lab tools**: Configured via env vars (`TTC_LAB_HOSTS`, `TTC_LAB_SERVICES`, `TTC_PROMETHEUS_URL`) — no hardcoded infrastructure

## Voice Backends

1. **Nova Sonic** (default): Single model does STT+LLM+TTS natively via Bedrock bidirectional HTTP/2 stream. Supports tool calling mid-conversation.
2. **Claude Brain** (legacy STT+TTS): Separate STT + TTS providers with Claude Sonnet (Bedrock Converse) as the conversation engine. Full tool calling loop.
3. **OpenAI**: Separate STT (Realtime WebSocket) + TTS (REST API) pipeline
4. **Self-hosted**: faster-whisper (STT, batch REST with client-side VAD) + Kokoro (TTS) on local GPU

## Conventions

- Runtime: Bun (not Node)
- Phone/SMS providers use raw `fetch()` — no SDK wrappers
- Nova Sonic uses `@aws-sdk/client-bedrock-runtime` (HTTP/2 bidirectional stream requires SDK)
- Audio: Always specify sample rate and bit depth in comments
- Errors: `console.error()` for logging (stdout is reserved for MCP stdio)
- Secrets/IPs: Never hardcoded — always via env vars or Terraform variables
