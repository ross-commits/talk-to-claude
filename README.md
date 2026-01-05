# CallMe

**Claude Code Plugin** - Claude calls you on the phone when it needs your input or wants to report progress.

## Quick Start

### 1. Get Required Accounts

You'll need:
- **Phone provider**: [Telnyx](https://telnyx.com) (~$0.007/min)
- **OpenAI API key**: For speech-to-text and text-to-speech
- **ngrok account**: Free at [ngrok.com](https://ngrok.com) (for webhook tunneling)

### 2. Set Up Phone Provider

**Telnyx:**
1. Create account at [portal.telnyx.com](https://portal.telnyx.com) and verify your identity.
2. [Buy a phone number](https://portal.telnyx.com/#/numbers/buy-numbers) (~$1/month) that Claude will use
3. [Create a Voice API application](https://portal.telnyx.com/#/call-control/applications) with the correct webhook URL.
  - The webhook URL should look like `https://your-ngrok-url/twiml`. You can get your ngrok URL from the [ngrok dashboard](https://dashboard.ngrok.com) or by running `ngrok http 3333`.
4. Note your Application ID and API Key.
5. Ensure you [verify your personal phone number](https://portal.telnyx.com/#/numbers/verified-numbers) you want to be called at on Telnyx.

### 3. Set Environment Variables

I've found that putting the env vars in `~/.claude/settings.json` (or the corresponding Claude Code config file for your plugin install scope) consistently works vs trying to export them to your shell directly. See [Claude docs](https://code.claude.com/docs/en/settings) for example configs.

#### Required

| Variable | Description |
|----------|-------------|
| `CALLME_PHONE_ACCOUNT_SID` | Telnyx Connection ID |
| `CALLME_PHONE_AUTH_TOKEN` | Telnyx API Key |
| `CALLME_PHONE_NUMBER` | Your Telnyx phone number (E.164 format) |
| `CALLME_USER_PHONE_NUMBER` | Your personal phone number to receive calls |
| `CALLME_OPENAI_API_KEY` | OpenAI API key (for TTS and realtime STT) |
| `CALLME_NGROK_AUTHTOKEN` | ngrok auth token for webhook tunneling |

#### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_TTS_VOICE` | `onyx` | OpenAI voice: alloy, echo, fable, onyx, nova, shimmer |
| `CALLME_PORT` | `3333` | Local HTTP server port |
| `CALLME_NGROK_DOMAIN` | - | Custom ngrok domain (paid feature) |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech (3 minutes default) |
| `CALLME_STT_SILENCE_DURATION_MS` | `800` | Silence duration to detect end of speech |

### 4. Install Plugin

```bash
/plugin marketplace add ZeframLou/call-me
/plugin install callme@callme
```

Restart Claude Code. Done!

## How It Works

```
Claude Code                    CallMe MCP Server (local)
    │                                    │
    │  "I finished the feature..."       │
    ▼                                    ▼
Plugin ────stdio──────────────────► MCP Server
                                         │
                                         ├─► ngrok tunnel
                                         │
                                         ▼
                                   Phone Provider (Telnyx)
                                         │
                                         ▼
                                   Your Phone rings
                                   You speak
                                   Text returns to Claude
```

The MCP server runs locally on your machine and automatically starts an ngrok tunnel for phone provider webhooks.

## Tools

### `initiate_call`
Start a phone call.

```typescript
const { callId, response } = await initiate_call({
  message: "Hey! I finished the auth system. What should I work on next?"
});
```

### `continue_call`
Continue with follow-up questions.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "Got it. Should I add rate limiting too?"
});
```

### `end_call`
End the call.

```typescript
await end_call({
  call_id: callId,
  message: "Perfect, I'll get started. Talk soon!"
});
```

## When Claude Calls You

- **Task completed** - Status report, asking what's next
- **Decision needed** - Architecture, technology choices
- **Blocked** - Needs clarification to continue

Claude won't call for simple yes/no questions.

## Costs

Running your own CallMe server costs:
- **Phone calls**: ~$0.007/min (Telnyx) or ~$0.014/min (Twilio)
- **Speech-to-text**: ~$0.006/min (OpenAI Whisper)
- **Text-to-speech**: ~$0.02/min (OpenAI TTS)
- **Phone number**: ~$1/month

**Total**: ~$0.03-0.04/minute of conversation

## Troubleshooting

### Claude doesn't use the tool
1. Check all required environment variables are set (ideally in `~/.claude/settings.json`)
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Call me to discuss the next steps when you're done."

### Call doesn't connect
1. Check the MCP server logs (stderr) in the Claude logs for errors (use `claude --debug`)
2. Verify your phone provider credentials are correct
3. Make sure ngrok is able to create a tunnel

### ngrok errors
1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3334`

## Development

```bash
cd server
bun install
bun run dev
```

## License

MIT
