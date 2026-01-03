import Twilio from 'twilio';
import { Config, validatePhoneNumber } from './config.js';
import { VoiceHandler, ConversationContext } from './voice-handler.js';
import WebSocket from 'ws';

export class PhoneService {
  private twilioClient: Twilio.Twilio;
  private server: any;
  private wss: WebSocket.Server | null = null;

  constructor(private config: Config) {
    this.twilioClient = Twilio(config.twilioAccountSid, config.twilioAuthToken);
  }

  async makeCall(question: string): Promise<string> {
    const context: ConversationContext = {
      question,
      timestamp: new Date().toISOString()
    };

    const callResult = await new Promise<string>((resolve, reject) => {
      this.startWebSocketServer(context, resolve, reject);

      const toNumber = validatePhoneNumber(this.config.userPhoneNumber);
      const fromNumber = validatePhoneNumber(this.config.twilioPhoneNumber);

      console.log(`Initiating call from ${fromNumber} to ${toNumber}`);

      this.twilioClient.calls
        .create({
          url: `${this.config.publicUrl}/twiml`,
          to: toNumber,
          from: fromNumber,
          timeout: 60,
          statusCallback: `${this.config.publicUrl}/status`,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        })
        .then((call) => {
          console.log('Call initiated:', call.sid);
        })
        .catch((error) => {
          console.error('Error initiating call:', error);
          this.stopWebSocketServer();
          reject(error);
        });
    });

    this.stopWebSocketServer();
    return callResult;
  }

  private startWebSocketServer(
    context: ConversationContext,
    resolve: (value: string) => void,
    reject: (reason: any) => void
  ) {
    this.server = Bun.serve({
      port: this.config.serverPort,
      fetch: (req, server) => {
        const url = new URL(req.url);

        if (url.pathname === '/twiml') {
          return new Response(this.getTwiML(), {
            headers: { 'Content-Type': 'application/xml' }
          });
        }

        if (url.pathname === '/status') {
          return new Response('OK', { status: 200 });
        }

        if (url.pathname === '/media-stream') {
          if (server.upgrade(req)) {
            return;
          }
          return new Response('Upgrade failed', { status: 500 });
        }

        return new Response('Not Found', { status: 404 });
      },
      websocket: {
        open: (ws) => {
          console.log('Twilio WebSocket connected');
          const handler = new VoiceHandler(this.config, context);

          handler.handleCall(ws as any)
            .then(resolve)
            .catch(reject);
        },
        message: () => {},
        close: () => {
          console.log('Twilio WebSocket disconnected');
        }
      }
    });

    console.log(`Server listening on port ${this.config.serverPort}`);
  }

  private stopWebSocketServer() {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  private getTwiML(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${new URL(this.config.publicUrl).host}/media-stream" />
  </Connect>
</Response>`;
  }
}
