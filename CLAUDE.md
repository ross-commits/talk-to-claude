# Talk to Claude (TTC)

Voice and text communication plugin for Claude Code. Fork of [ZeframLou/call-me](https://github.com/ZeframLou/call-me).

## Architecture

```
server/src/
  index.ts              # MCP server entry point (stdio transport)
  phone-call.ts         # CallManager: call lifecycle, WebSocket audio, HTTP webhooks
  ngrok.ts              # ngrok tunnel management with health checks
  webhook-security.ts   # Twilio HMAC-SHA1 + Telnyx Ed25519 signature validation
  providers/
    types.ts            # Provider interfaces (PhoneProvider, TTSProvider, RealtimeSTTProvider)
    index.ts            # Provider factory (env var -> provider instances)
    phone-twilio.ts     # Twilio voice (primary)
    phone-telnyx.ts     # Telnyx voice (kept from upstream)
    tts-openai.ts       # OpenAI TTS (fallback)
    stt-openai-realtime.ts  # OpenAI Realtime STT (fallback)
    voice-nova-sonic.ts # AWS Nova Sonic speech-to-speech (default)
    sms-twilio.ts       # Twilio SMS/MMS
    stt-self-hosted.ts  # Self-hosted STT stub (faster-whisper)
    tts-self-hosted.ts  # Self-hosted TTS (Kokoro/MeloTTS/Piper)
```

## Key Patterns

- **Provider interfaces**: All services behind interfaces in `types.ts`, factory in `index.ts`
- **Env var prefix**: `TTC_` (changed from `CALLME_` in upstream)
- **Audio pipeline**: mu-law 8kHz (Twilio) <-> PCM 16kHz (Nova Sonic in) / PCM 24kHz (Nova Sonic out)
- **MCP tools**: Registered via `@modelcontextprotocol/sdk`, communicated over stdio
- **No Twilio SDK**: All Twilio API calls use raw `fetch()` to keep dependencies minimal

## Voice Backends

1. **Nova Sonic** (default): Single model does STT+TTS natively via Bedrock bidirectional HTTP/2 stream
2. **OpenAI**: Separate STT (Realtime WebSocket) + TTS (REST API) pipeline
3. **Self-hosted**: faster-whisper (STT) + Kokoro (TTS) on local GPU servers

## Lab Infrastructure

- **Yori** (192.168.3.100): Ubuntu 24.04, RTX 4070 Super 12GB, 64GB RAM, x86_64
  - Runs: faster-whisper STT (port 8000), Kokoro TTS (port 8001) via Docker GPU
- **Vlad** (192.168.3.30): Ubuntu 24.04, no GPU, 64GB RAM, i7-8700B
  - Runs: infra stack (Grafana, Prometheus, LiteLLM, Open WebUI, n8n, Caddy)
- **Spark01** (192.168.3.20): NVIDIA DGX Spark, GB10, 128GB unified RAM, aarch64
- **Spark02** (192.168.3.21): Same as Spark01, backup faster-whisper instance
- **AWS** (us-east-1): VPC 10.100.0.0/16, site-to-site VPN, Bedrock VPC endpoints

## Implementation Status

- [x] Rebrand to TTC with TTC_ env vars
- [x] Nova Sonic provider scaffolding + audio conversion utils
- [x] SMS provider (Twilio)
- [x] Self-hosted TTS provider (OpenAI-compatible API)
- [x] Self-hosted STT stub
- [x] Wire new providers into factory (index.ts)
- [x] Update index.ts with SMS MCP tools (send_text)
- [x] Update all env vars (CALLME_ -> TTC_) in phone-call.ts, ngrok.ts, index.ts
- [ ] Implement Nova Sonic session (Bedrock bidirectional stream)
- [ ] Implement self-hosted STT session (WebSocket to faster-whisper)
- [ ] Add SMS webhook handler (/sms route)
- [ ] Add @aws-sdk/client-bedrock-runtime dependency
- [x] Deploy Kokoro TTS + faster-whisper STT on Yori (RTX 4070 Super)

## Conventions

- Runtime: Bun (not Node)
- All providers use raw `fetch()` -- no SDK wrappers
- Audio: Always specify sample rate and bit depth in comments
- Errors: `console.error()` for logging (stdout is reserved for MCP stdio)
