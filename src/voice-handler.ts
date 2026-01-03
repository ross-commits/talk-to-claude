import WebSocket from 'ws';
import { Config } from './config.js';

export interface ConversationContext {
  question: string;
  timestamp: string;
}

export class VoiceHandler {
  private openaiWs: WebSocket | null = null;
  private twilioWs: WebSocket | null = null;
  private streamSid: string | null = null;
  private conversationHistory: string[] = [];
  private userResponses: string[] = [];
  private isComplete = false;

  constructor(
    private config: Config,
    private context: ConversationContext
  ) {}

  async handleCall(twilioWebSocket: WebSocket): Promise<string> {
    this.twilioWs = twilioWebSocket;

    return new Promise((resolve, reject) => {
      this.initializeOpenAI(resolve, reject);

      twilioWebSocket.on('message', (message: string) => {
        try {
          const msg = JSON.parse(message);
          this.handleTwilioMessage(msg);
        } catch (error) {
          console.error('Error parsing Twilio message:', error);
        }
      });

      twilioWebSocket.on('close', () => {
        this.cleanup();
        if (!this.isComplete) {
          reject(new Error('Call ended prematurely'));
        }
      });

      twilioWebSocket.on('error', (error) => {
        console.error('Twilio WebSocket error:', error);
        this.cleanup();
        reject(error);
      });
    });
  }

  private initializeOpenAI(resolve: (value: string) => void, reject: (reason: any) => void) {
    const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
    this.openaiWs = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${this.config.openaiApiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    this.openaiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      this.sendSessionUpdate();
    });

    this.openaiWs.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleOpenAIEvent(event, resolve, reject);
      } catch (error) {
        console.error('Error parsing OpenAI message:', error);
      }
    });

    this.openaiWs.on('error', (error) => {
      console.error('OpenAI WebSocket error:', error);
      reject(error);
    });

    this.openaiWs.on('close', () => {
      console.log('OpenAI WebSocket closed');
    });
  }

  private sendSessionUpdate() {
    const systemMessage = `You are a helpful assistant conducting a phone call for Claude Code, an AI coding assistant.

Context: Claude Code needs user input about the following:
${this.context.question}

Your task:
1. Briefly explain what Claude Code needs (1-2 sentences)
2. Ask the user for their input
3. Listen carefully to their response
4. Ask clarifying questions if needed
5. Once you have a complete answer, say "Thank you, I'll relay this to Claude Code" and end the call

Keep responses concise and natural for phone conversation. Be helpful and professional.`;

    this.openaiWs?.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemMessage,
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
        temperature: 0.8
      }
    }));
  }

  private handleTwilioMessage(msg: any) {
    switch (msg.event) {
      case 'start':
        this.streamSid = msg.start.streamSid;
        console.log('Call started, streamSid:', this.streamSid);
        break;

      case 'media':
        if (this.openaiWs?.readyState === WebSocket.OPEN) {
          this.openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          }));
        }
        break;

      case 'stop':
        console.log('Call ended');
        this.cleanup();
        break;
    }
  }

  private handleOpenAIEvent(event: any, resolve: (value: string) => void, reject: (reason: any) => void) {
    switch (event.type) {
      case 'session.created':
        console.log('Session created');
        break;

      case 'session.updated':
        console.log('Session updated');
        break;

      case 'response.audio.delta':
        if (this.twilioWs?.readyState === WebSocket.OPEN && this.streamSid) {
          this.twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: {
              payload: event.delta
            }
          }));
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        const userText = event.transcript;
        console.log('User said:', userText);
        this.conversationHistory.push(`User: ${userText}`);
        this.userResponses.push(userText);
        break;

      case 'response.done':
        const response = event.response;
        if (response.output && response.output.length > 0) {
          const assistantText = response.output
            .filter((item: any) => item.type === 'message')
            .map((item: any) => item.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join(' '))
            .join(' ');

          if (assistantText) {
            console.log('Assistant said:', assistantText);
            this.conversationHistory.push(`Assistant: ${assistantText}`);

            if (assistantText.toLowerCase().includes("i'll relay this to claude") ||
                assistantText.toLowerCase().includes("thank you")) {
              this.completeCall(resolve);
            }
          }
        }
        break;

      case 'error':
        console.error('OpenAI error:', event.error);
        reject(new Error(event.error.message));
        break;
    }
  }

  private completeCall(resolve: (value: string) => void) {
    this.isComplete = true;

    setTimeout(() => {
      const result = this.userResponses.join('\n\n');
      console.log('Call completed with result:', result);
      this.cleanup();
      resolve(result || 'No response captured');
    }, 2000);
  }

  private cleanup() {
    if (this.openaiWs) {
      this.openaiWs.close();
      this.openaiWs = null;
    }
  }
}
