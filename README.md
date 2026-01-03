# Hey Boss 📞

Production-ready phone call input tool for Claude Code. When Claude needs your input, it calls you on the phone, explains what it needs, listens to your response, asks clarifying questions, and continues working with your guidance.

## Features

- **Phone-Based Input**: Claude calls you when it needs clarification or decisions
- **Natural Conversation**: Uses OpenAI's Realtime API for natural voice interaction
- **Smart Questioning**: Asks follow-up questions to get complete answers
- **Production Ready**: Built with Twilio for reliable phone calls
- **Simple Integration**: Easy-to-use CLI tool and hook system
- **KISS Principle**: Clean, maintainable code without over-engineering

## Prerequisites

1. **Bun** - Fast JavaScript runtime
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Twilio Account** - For phone calls
   - Sign up at [twilio.com](https://www.twilio.com/try-twilio)
   - Get a phone number with voice capabilities
   - Note your Account SID and Auth Token

3. **OpenAI Account** - For voice conversation
   - Sign up at [platform.openai.com](https://platform.openai.com)
   - Create an API key
   - Ensure you have access to GPT-4 Realtime API

4. **Public URL** - For webhooks
   - For production: Use your domain with HTTPS
   - For development: Use [ngrok](https://ngrok.com)
     ```bash
     ngrok http 3000
     ```

## Installation

1. Clone and install:
   ```bash
   git clone <repository-url>
   cd hey-boss
   bun install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. Set up your `.env` file:
   ```env
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token_here
   TWILIO_PHONE_NUMBER=+1234567890
   USER_PHONE_NUMBER=+1234567890
   OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   PUBLIC_URL=https://your-domain.com
   PORT=3000
   ```

4. Make the CLI globally available (optional):
   ```bash
   bun link
   ```

## Usage

### Direct CLI Usage

```bash
# Basic usage
bun run src/cli.ts "Should I proceed with refactoring the auth module?"

# Or if globally linked
hey-boss "Which API endpoint should I use for user data?"
```

### From Claude Code

Claude Code can invoke this tool directly:

```bash
# In a Bash tool call from Claude Code
hey-boss "I need to choose between REST and GraphQL. What's your preference?"
```

### As a Hook

Configure Claude Code to call you when tasks complete:

1. Create a Claude Code hook configuration (check Claude Code docs for hook setup)
2. Point to `hook/claude-finish-hook.sh`
3. Claude will automatically call you when it finishes tasks

Example hook configuration:
```bash
# In your Claude Code hooks config
on_finish: /path/to/hey-boss/hook/claude-finish-hook.sh
```

## How It Works

1. **You invoke the tool** with a question or context
2. **Server starts** and creates a Twilio call to your phone
3. **Call connects** to OpenAI Realtime API for voice conversation
4. **AI explains** what Claude Code needs
5. **You respond** naturally by speaking
6. **AI asks** clarifying questions if needed
7. **Call ends** when AI has a complete answer
8. **Response returns** to Claude Code to continue working

## Architecture

```
┌─────────────┐
│ Claude Code │
└──────┬──────┘
       │ invokes
       ▼
┌─────────────┐
│   CLI Tool  │
└──────┬──────┘
       │ starts
       ▼
┌─────────────┐      ┌──────────┐
│   Server    │◄────►│  Twilio  │
└──────┬──────┘      └────┬─────┘
       │                   │
       │ WebSocket         │ Phone Call
       │                   │
       ▼                   ▼
┌─────────────┐      ┌──────────┐
│   OpenAI    │      │   You    │
│  Realtime   │      │          │
└─────────────┘      └──────────┘
```

## Development

### Project Structure

```
hey-boss/
├── src/
│   ├── cli.ts           # CLI entry point
│   ├── config.ts        # Configuration management
│   ├── phone-service.ts # Twilio integration
│   └── voice-handler.ts # OpenAI Realtime API handler
├── hook/
│   └── claude-finish-hook.sh  # Post-task completion hook
├── package.json
├── tsconfig.json
└── README.md
```

### Running in Development

1. Start ngrok (in a separate terminal):
   ```bash
   ngrok http 3000
   ```

2. Update `.env` with ngrok URL:
   ```env
   PUBLIC_URL=https://abc123.ngrok.io
   ```

3. Run the tool:
   ```bash
   bun run src/cli.ts "Test question"
   ```

### Testing

Test the complete flow:

```bash
# Test with a simple question
bun run src/cli.ts "What's your favorite color?"

# Expected flow:
# 1. You receive a phone call
# 2. AI asks the question
# 3. You answer
# 4. AI thanks you and ends call
# 5. Your response prints to console
```

## Production Deployment

### Option 1: VPS Deployment

1. Set up a server with:
   - Bun installed
   - Domain with SSL certificate
   - Firewall allowing inbound on your chosen port

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit with production values
   ```

3. Run as a service (systemd example):
   ```ini
   [Unit]
   Description=Hey Boss Phone Service
   After=network.target

   [Service]
   Type=simple
   User=youruser
   WorkingDirectory=/path/to/hey-boss
   ExecStart=/usr/local/bin/bun run src/cli.ts
   Restart=on-failure
   EnvironmentFile=/path/to/hey-boss/.env

   [Install]
   WantedBy=multi-user.target
   ```

### Option 2: Serverless (Vercel/Netlify)

The tool is designed to run as a short-lived process. For serverless:

1. Deploy to a function platform that supports WebSockets
2. Ensure function timeout is at least 2 minutes
3. Configure environment variables in platform settings

## Troubleshooting

### Call Not Connecting

- Verify Twilio credentials are correct
- Check that TWILIO_PHONE_NUMBER is valid and has voice capability
- Ensure USER_PHONE_NUMBER is in E.164 format (+1234567890)
- Verify PUBLIC_URL is reachable from internet

### No Audio

- Check OpenAI API key is valid
- Verify you have access to GPT-4 Realtime API
- Check OpenAI account has sufficient credits

### WebSocket Errors

- Ensure PUBLIC_URL uses HTTPS (required by Twilio in production)
- For ngrok, verify tunnel is running and URL matches .env
- Check firewall allows inbound connections on specified port

### Permission Errors

```bash
# Make hook script executable
chmod +x hook/claude-finish-hook.sh
```

## Security Considerations

- **Never commit `.env`** - Contains sensitive credentials
- **Use HTTPS in production** - Required for secure WebSocket connections
- **Rotate API keys** - Regularly rotate Twilio and OpenAI keys
- **Limit phone numbers** - Consider validating calls are only to/from expected numbers
- **Monitor usage** - Watch Twilio and OpenAI usage to prevent abuse

## Cost Estimates

- **Twilio**: ~$0.01-0.02 per minute for calls
- **OpenAI Realtime API**: ~$0.06 per minute for audio input, ~$0.24 per minute for audio output
- **Total**: ~$0.30-0.40 per minute of conversation

A typical 2-minute call costs approximately $0.60-0.80.

## Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio account identifier | `ACxxxxx...` |
| `TWILIO_AUTH_TOKEN` | Twilio authentication token | `your_token` |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number | `+1234567890` |
| `USER_PHONE_NUMBER` | Your personal phone number | `+1234567890` |
| `OPENAI_API_KEY` | OpenAI API key | `sk-xxxxx...` |
| `PUBLIC_URL` | Public server URL (HTTPS) | `https://example.com` |
| `PORT` | Server port (optional) | `3000` |

## License

MIT

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

For issues or questions:

1. Check the Troubleshooting section
2. Review Twilio and OpenAI documentation
3. Open an issue on GitHub
