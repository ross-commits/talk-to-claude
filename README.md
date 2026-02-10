# Talk to Claude (TTC)

**Voice and text communication with Claude Code -- powered by AWS Nova Sonic.**

Call or text Claude from your phone. Start a task, walk away. Your phone rings when Claude is done, stuck, or needs a decision. Text when a call isn't convenient.

> **Fork of [ZeframLou/call-me](https://github.com/ZeframLou/call-me)** -- the original minimal phone plugin for Claude Code. TTC expands on call-me with AWS Nova Sonic speech-to-speech, SMS/MMS support, and self-hosted STT/TTS options. Huge thanks to [@ZeframLou](https://github.com/ZeframLou) for the original architecture and idea.

---

## What's Different from call-me?

| Feature | call-me | TTC |
|---------|---------|-----|
| Voice engine | OpenAI STT + TTS (text pipeline) | **AWS Nova Sonic** (native speech-to-speech) |
| SMS/texting | No | **Yes** -- same Twilio number |
| Phone provider | Telnyx (default) or Twilio | **Twilio** (primary) |
| Self-hosted models | No | **Yes** -- Kokoro TTS, faster-whisper on local GPU |
| Voice latency | ~1-2s (STT -> text -> TTS) | **~300ms** (Nova Sonic end-to-end) |
| Barge-in | No | **Yes** -- interrupt Claude mid-sentence |
| Tool use during speech | No | **Yes** -- Nova Sonic native tool calling |

---

## Quick Start

### 1. Get Accounts

- **[Twilio](https://twilio.com)** -- phone number for voice + SMS ($1.15/month)
- **[AWS](https://aws.amazon.com)** -- for Nova Sonic via Bedrock (`aws configure`)
- **[ngrok](https://ngrok.com)** -- free account for webhook tunneling

### 2. Set Environment Variables

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "TTC_PHONE_PROVIDER": "twilio",
    "TTC_PHONE_ACCOUNT_SID": "your-account-sid",
    "TTC_PHONE_AUTH_TOKEN": "your-auth-token",
    "TTC_PHONE_NUMBER": "+15551234567",
    "TTC_USER_PHONE_NUMBER": "+15559876543",
    "TTC_VOICE_BACKEND": "nova-sonic",
    "TTC_AWS_REGION": "us-east-1",
    "TTC_NGROK_AUTHTOKEN": "your-ngrok-token"
  }
}
```

### 3. Install Plugin

```bash
/plugin marketplace add ross-commits/talk-to-claude
/plugin install ttc@ttc
```

Restart Claude Code. Done!

---

## Voice Backends

### AWS Nova Sonic (Default -- Recommended)

Native speech-to-speech via Amazon Bedrock. No separate STT/TTS pipeline -- the model understands and generates speech directly. Supports barge-in, tool use mid-conversation, and voice activity detection.

```bash
TTC_VOICE_BACKEND=nova-sonic
TTC_AWS_REGION=us-east-1
TTC_NOVA_SONIC_MODEL=amazon.nova-sonic-v1:0
TTC_NOVA_SONIC_VOICE=tiffany
```

Requires AWS credentials (`aws configure` or env vars). Available in us-east-1, us-west-2, ap-northeast-1, eu-north-1.

### OpenAI (Fallback)

The original call-me approach: OpenAI Realtime STT + TTS. Higher latency but works well.

```bash
TTC_VOICE_BACKEND=openai
TTC_OPENAI_API_KEY=sk-...
TTC_TTS_VOICE=onyx
```

### Self-Hosted (Local GPU)

Run STT and TTS on your own hardware. Great for privacy, zero API costs, and tinkering.

```bash
TTC_VOICE_BACKEND=self-hosted
TTC_SELF_HOSTED_STT_URL=http://192.168.3.20:8000   # faster-whisper-server
TTC_SELF_HOSTED_TTS_URL=http://192.168.3.20:8001   # Kokoro TTS
```

**Recommended models:**
- **STT**: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) large-v3 (INT8) -- ~200ms latency, ~3-4GB VRAM
- **TTS**: [Kokoro](https://github.com/remsky/Kokoro-FastAPI) (82M params) -- ~30-100ms TTFA, ~1GB VRAM

---

## Tools

### Voice

| Tool | Description |
|------|-------------|
| `initiate_call` | Start a phone call with the user |
| `continue_call` | Continue an active call with a follow-up |
| `speak_to_user` | Speak without waiting for response (acknowledgments) |
| `end_call` | End the call with a closing message |

### Text (Coming Soon)

| Tool | Description |
|------|-------------|
| `send_text` | Send an SMS/MMS to the user |
| `check_texts` | Check for incoming text messages |

---

## Architecture

```
Claude Code                    TTC MCP Server (local)
    |                                    |
    |  "I finished the feature..."       |
    v                                    v
Plugin ----stdio----------------> MCP Server
                                         |
                                    +---------+
                                    |         |
                                    v         v
                               Voice Path  Text Path
                                    |         |
                                    v         v
                              Nova Sonic   Twilio SMS
                              (Bedrock)    REST API
                                    |         |
                                    v         v
                              Twilio Media  Your Phone
                              Stream (WS)   receives SMS
                                    |
                                    v
                              Your Phone rings
                              You speak
                              Text returns to Claude
```

---

## Costs

| Service | Cost |
|---------|------|
| Twilio outbound calls | ~$0.014/min |
| Twilio phone number | ~$1.15/month |
| Twilio SMS (outbound) | ~$0.0079/segment |
| Nova Sonic (Bedrock) | ~$0.0017/sec input, ~$0.007/sec output |
| OpenAI STT+TTS (if used) | ~$0.03/min |

**Typical voice call**: ~$0.04-0.06/minute

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `TTC_PHONE_PROVIDER` | `twilio` |
| `TTC_PHONE_ACCOUNT_SID` | Twilio Account SID |
| `TTC_PHONE_AUTH_TOKEN` | Twilio Auth Token |
| `TTC_PHONE_NUMBER` | Phone number Claude calls from (E.164) |
| `TTC_USER_PHONE_NUMBER` | Your phone number to receive calls |
| `TTC_VOICE_BACKEND` | `nova-sonic`, `openai`, or `self-hosted` |
| `TTC_NGROK_AUTHTOKEN` | ngrok auth token |

### Nova Sonic

| Variable | Default | Description |
|----------|---------|-------------|
| `TTC_AWS_REGION` | `us-east-1` | AWS region for Bedrock |
| `TTC_NOVA_SONIC_MODEL` | `amazon.nova-sonic-v1:0` | Model ID |
| `TTC_NOVA_SONIC_VOICE` | `tiffany` | Voice ID |

### OpenAI (if using openai backend)

| Variable | Default | Description |
|----------|---------|-------------|
| `TTC_OPENAI_API_KEY` | - | OpenAI API key |
| `TTC_TTS_VOICE` | `onyx` | TTS voice |

### Self-Hosted (if using self-hosted backend)

| Variable | Description |
|----------|-------------|
| `TTC_SELF_HOSTED_STT_URL` | URL of faster-whisper server |
| `TTC_SELF_HOSTED_TTS_URL` | URL of Kokoro/MeloTTS server |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `TTC_PORT` | `3333` | Local HTTP server port |
| `TTC_NGROK_DOMAIN` | - | Custom ngrok domain (paid) |
| `TTC_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech |
| `TTC_STT_SILENCE_DURATION_MS` | `800` | Silence duration for end-of-speech |

---

## Development

```bash
cd server
bun install
bun run dev
```

---

## Credits

This project is a fork of **[call-me](https://github.com/ZeframLou/call-me)** by [@ZeframLou](https://github.com/ZeframLou). The original project created the brilliant idea of giving Claude Code a phone -- we're building on that foundation with AWS-native voice, SMS support, and self-hosted model options.

## License

MIT
