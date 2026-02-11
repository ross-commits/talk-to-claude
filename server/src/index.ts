#!/usr/bin/env bun

/**
 * Talk to Claude (TTC) MCP Server
 *
 * A stdio-based MCP server that lets Claude call or text you.
 * Supports voice (Nova Sonic, OpenAI, self-hosted) and SMS via Twilio.
 *
 * Webhook URL can be provided directly via TTC_WEBHOOK_URL (e.g. API Gateway,
 * Cloudflare Tunnel, etc.) or auto-tunnelled via ngrok as a fallback.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CallManager, loadServerConfig } from './phone-call.js';
import { TwilioSMSProvider } from './providers/sms-twilio.js';
import { loadProviderConfig } from './providers/index.js';

/**
 * Resolve public URLs for Twilio.
 *
 * Two URLs are needed:
 *   - webhookUrl: HTTP endpoint for TwiML webhooks (API Gateway, Cloudflare Tunnel, etc.)
 *   - wsUrl: WebSocket-capable endpoint for Twilio media streams
 *
 * API Gateway HTTP API doesn't support WebSocket upgrade, so when using it
 * for webhooks we start an ngrok tunnel (outbound from server) for WebSocket.
 * If TTC_WS_URL is set explicitly, ngrok is not needed.
 * If neither TTC_WEBHOOK_URL nor TTC_WS_URL is set, ngrok handles both.
 */
async function resolveUrls(port: number): Promise<{ webhookUrl: string; wsUrl: string; usingNgrok: boolean }> {
  const envWebhookUrl = process.env.TTC_WEBHOOK_URL?.replace(/\/+$/, '');
  const envWsUrl = process.env.TTC_WS_URL?.replace(/\/+$/, '');

  // Case 1: Both URLs provided explicitly — no ngrok needed
  if (envWebhookUrl && envWsUrl) {
    console.error(`Webhook URL: ${envWebhookUrl}`);
    console.error(`WebSocket URL: ${envWsUrl}`);
    return { webhookUrl: envWebhookUrl, wsUrl: envWsUrl, usingNgrok: false };
  }

  // Case 2: Only webhook URL (e.g. API Gateway) — need ngrok for WebSocket
  if (envWebhookUrl && !envWsUrl) {
    console.error(`Webhook URL: ${envWebhookUrl}`);
    console.error('Starting ngrok tunnel for WebSocket media streams...');
    const { startNgrok } = await import('./ngrok.js');
    const ngrokUrl = await startNgrok(port);
    console.error(`WebSocket URL (ngrok): ${ngrokUrl}`);
    return { webhookUrl: envWebhookUrl, wsUrl: ngrokUrl, usingNgrok: true };
  }

  // Case 3: No webhook URL — ngrok handles everything
  console.error('No TTC_WEBHOOK_URL set — falling back to ngrok tunnel for all traffic...');
  const { startNgrok } = await import('./ngrok.js');
  const ngrokUrl = await startNgrok(port);
  console.error(`ngrok tunnel (HTTP + WS): ${ngrokUrl}`);
  return { webhookUrl: ngrokUrl, wsUrl: ngrokUrl, usingNgrok: true };
}

async function main() {
  // Get port for HTTP server
  const port = parseInt(process.env.TTC_PORT || '3333', 10);

  // Resolve public URLs (webhook + WebSocket)
  let webhookUrl: string;
  let wsUrl: string;
  let usingNgrok = false;
  try {
    const resolved = await resolveUrls(port);
    webhookUrl = resolved.webhookUrl;
    wsUrl = resolved.wsUrl;
    usingNgrok = resolved.usingNgrok;
  } catch (error) {
    console.error('Failed to resolve public URLs:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Load server config with the public URLs
  let serverConfig;
  try {
    serverConfig = loadServerConfig(webhookUrl, wsUrl, usingNgrok);
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    if (usingNgrok) {
      const { stopNgrok } = await import('./ngrok.js');
      await stopNgrok();
    }
    process.exit(1);
  }

  // Create call manager and start HTTP server for webhooks
  const callManager = new CallManager(serverConfig);
  callManager.startServer();

  // Initialize SMS provider (uses same Twilio credentials as phone)
  const providerConfig = loadProviderConfig();
  let smsProvider: TwilioSMSProvider | null = null;
  if (providerConfig.phoneProvider === 'twilio' && providerConfig.phoneAccountSid && providerConfig.phoneAuthToken) {
    smsProvider = new TwilioSMSProvider();
    smsProvider.initialize({
      accountSid: providerConfig.phoneAccountSid,
      authToken: providerConfig.phoneAuthToken,
      phoneNumber: providerConfig.phoneNumber,
    });
  }

  const userPhoneNumber = process.env.TTC_USER_PHONE_NUMBER || '';

  // Create stdio MCP server
  const mcpServer = new Server(
    { name: 'ttc', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      {
        name: 'initiate_call',
        description: 'Start a phone call with the user. Use when you need voice input, want to report completed work, or need real-time discussion.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: {
              type: 'string',
              description: 'What you want to say to the user. Be natural and conversational.',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'continue_call',
        description: 'Continue an active call with a follow-up message.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            call_id: { type: 'string', description: 'The call ID from initiate_call' },
            message: { type: 'string', description: 'Your follow-up message' },
          },
          required: ['call_id', 'message'],
        },
      },
      {
        name: 'speak_to_user',
        description: 'Speak a message on an active call without waiting for a response. Use this to acknowledge requests or provide status updates before starting time-consuming operations.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            call_id: { type: 'string', description: 'The call ID from initiate_call' },
            message: { type: 'string', description: 'What to say to the user' },
          },
          required: ['call_id', 'message'],
        },
      },
      {
        name: 'end_call',
        description: 'End an active call with a closing message.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            call_id: { type: 'string', description: 'The call ID from initiate_call' },
            message: { type: 'string', description: 'Your closing message (say goodbye!)' },
          },
          required: ['call_id', 'message'],
        },
      },
    ];

    // Add SMS tools if Twilio SMS is available
    if (smsProvider) {
      tools.push({
        name: 'send_text',
        description: 'Send an SMS or MMS text message to the user. Use for quick updates, sharing links/code, or when a call is not appropriate.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: { type: 'string', description: 'The text message to send' },
            media_urls: {
              type: 'array',
              description: 'Optional: publicly accessible URLs for MMS attachments (images, etc.)',
              items: { type: 'string' },
            },
          },
          required: ['message'],
        },
      });
    }

    return { tools };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'initiate_call') {
        const { message } = request.params.arguments as { message: string };
        const result = await callManager.initiateCall(message);

        return {
          content: [{
            type: 'text',
            text: `Call initiated successfully.\n\nCall ID: ${result.callId}\n\nUser's response:\n${result.response}\n\nUse continue_call to ask follow-ups or end_call to hang up.`,
          }],
        };
      }

      if (request.params.name === 'continue_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const response = await callManager.continueCall(call_id, message);

        return {
          content: [{ type: 'text', text: `User's response:\n${response}` }],
        };
      }

      if (request.params.name === 'speak_to_user') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        await callManager.speakOnly(call_id, message);

        return {
          content: [{ type: 'text', text: `Message spoken: "${message}"` }],
        };
      }

      if (request.params.name === 'end_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const { durationSeconds } = await callManager.endCall(call_id, message);

        return {
          content: [{ type: 'text', text: `Call ended. Duration: ${durationSeconds}s` }],
        };
      }

      if (request.params.name === 'send_text') {
        if (!smsProvider) {
          throw new Error('SMS not available (requires Twilio phone provider)');
        }
        const { message, media_urls } = request.params.arguments as { message: string; media_urls?: string[] };
        const messageSid = await smsProvider.sendSMS(userPhoneNumber, message, media_urls);

        return {
          content: [{ type: 'text', text: `Text sent to ${userPhoneNumber}: "${message}" (SID: ${messageSid})` }],
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  const voiceBackend = providerConfig.voiceBackend || 'nova-sonic';
  const brainMode = voiceBackend !== 'nova-sonic' ? `Claude Brain (${serverConfig.claudeModel})` : 'Nova Sonic (built-in)';
  console.error('');
  console.error('TTC MCP server ready');
  console.error(`Phone: ${serverConfig.phoneNumber} -> ${serverConfig.userPhoneNumber}`);
  console.error(`Voice: ${voiceBackend} | Phone: ${serverConfig.providers.phone.name} | TTS: ${serverConfig.providers.tts.name} | STT: ${serverConfig.providers.stt.name}`);
  console.error(`Brain: ${brainMode}`);
  if (smsProvider) {
    console.error(`SMS: enabled (same Twilio number)`);
  }
  console.error('');

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    callManager.shutdown();
    if (usingNgrok) {
      const { stopNgrok } = await import('./ngrok.js');
      await stopNgrok();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
