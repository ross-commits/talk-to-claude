# Hey Boss

**Claude Code Plugin** - Claude calls you on the phone when it needs your input, wants to report progress, or needs to discuss next steps.

## Install

```
/plugin marketplace add ZeframLou/hey-boss
/plugin install hey-boss@hey-boss
```

## Setup

### 1. Get API Credentials

**Twilio** - [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
- Create account and get a phone number with voice capabilities
- Note your Account SID and Auth Token from the console

**OpenAI** - [platform.openai.com](https://platform.openai.com)
- Create an API key with access to Whisper and TTS

### 2. Expose Your Local Server

The plugin runs an HTTP server on your machine that Twilio needs to reach. Use ngrok to create a public URL:

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

ngrok will show a forwarding URL like:
```
Forwarding  https://abc123.ngrok.io -> http://localhost:3000
```

This `https://abc123.ngrok.io` is your `PUBLIC_URL`.

**Note:** Free ngrok URLs change each time you restart. For production, use a paid ngrok plan or deploy to a server with a fixed domain.

### 3. Set Environment Variables

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
export TWILIO_ACCOUNT_SID=ACxxxxx
export TWILIO_AUTH_TOKEN=your_token
export TWILIO_PHONE_NUMBER=+1234567890   # Your Twilio number
export USER_PHONE_NUMBER=+1234567890     # Your personal phone
export OPENAI_API_KEY=sk-xxxxx
export PUBLIC_URL=https://abc123.ngrok.io  # Your ngrok URL
```

### 4. Restart Claude Code

The `initiate_call`, `continue_call`, and `end_call` tools will be available.

## How It Works

```
Your Machine                              External Services
┌──────────────────────────┐
│ Claude Code              │
│    │ MCP (stdio)         │
│    ▼                     │
│ Hey Boss Plugin          │              ┌─────────────┐
│    │                     │◄─────────────│   Twilio    │
│    │ HTTP server :3000   │   webhook    │  (calls)    │
│    │                     │──────────────►└─────────────┘
│    ▼                     │
│ ngrok tunnel             │              ┌─────────────┐
│    │                     │──────────────►│   OpenAI    │
└────│─────────────────────┘   API calls  │ (Whisper/TTS)│
     │                                    └─────────────┘
     ▼
PUBLIC_URL (https://abc123.ngrok.io)
```

**Important:** Your machine must be running with ngrok active for calls to work.

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

## Cost

~$0.05-0.08/min (Twilio + Whisper + TTS)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio account ID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio number (caller ID) |
| `USER_PHONE_NUMBER` | Your phone number (receives calls) |
| `OPENAI_API_KEY` | OpenAI API key |
| `PUBLIC_URL` | Your ngrok URL (e.g., `https://abc123.ngrok.io`) |
| `PORT` | Server port (default: 3000) |

## Troubleshooting

### Call doesn't connect
1. Is ngrok running? (`ngrok http 3000`)
2. Does `PUBLIC_URL` match your current ngrok URL?
3. Is your Twilio phone number verified for voice?

### No audio
1. Check OpenAI API key is valid
2. Verify OpenAI account has credits

### Claude doesn't use the tool
1. Restart Claude Code after installing plugin
2. Try explicitly: "Call me to discuss the next steps"

## Development

```bash
git clone https://github.com/ZeframLou/hey-boss.git
cd hey-boss/mcp-server
bun install && bun run build
```

## License

MIT
