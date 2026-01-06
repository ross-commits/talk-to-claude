import WebSocket, { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  loadProviderConfig,
  createProviders,
  validateProviderConfig,
  type ProviderRegistry,
  type RealtimeSTTSession,
} from './providers/index.js';

interface CallState {
  callId: string;
  callControlId: string | null;
  userPhoneNumber: string;
  ws: WebSocket | null;
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  hungUp: boolean;
  sttSession: RealtimeSTTSession | null;
}

export interface ServerConfig {
  publicUrl: string;
  port: number;
  phoneNumber: string;
  userPhoneNumber: string;
  providers: ProviderRegistry;
  transcriptTimeoutMs: number;
}

export function loadServerConfig(publicUrl: string): ServerConfig {
  const providerConfig = loadProviderConfig();
  const errors = validateProviderConfig(providerConfig);

  if (!process.env.CALLME_USER_PHONE_NUMBER) {
    errors.push('Missing CALLME_USER_PHONE_NUMBER (where to call you)');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const providers = createProviders(providerConfig);

  // Default 3 minutes for transcript timeout
  const transcriptTimeoutMs = parseInt(process.env.CALLME_TRANSCRIPT_TIMEOUT_MS || '180000', 10);

  return {
    publicUrl,
    port: parseInt(process.env.CALLME_PORT || '3333', 10),
    phoneNumber: providerConfig.phoneNumber,
    userPhoneNumber: process.env.CALLME_USER_PHONE_NUMBER!,
    providers,
    transcriptTimeoutMs,
  };
}

export class CallManager {
  private activeCalls = new Map<string, CallState>();
  private callControlIdToCallId = new Map<string, string>();
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private config: ServerConfig;
  private currentCallId = 0;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  startServer(): void {
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === '/twiml') {
        this.handlePhoneWebhook(req, res);
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeCalls: this.activeCalls.size }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      console.error('Media stream WebSocket connected');
      let associatedCallId: string | null = null;

      ws.on('message', (message: Buffer | string) => {
        const msgBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

        // Try to associate with a call if not already
        if (!associatedCallId) {
          for (const [callId, state] of this.activeCalls.entries()) {
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
              state.ws = ws;
              associatedCallId = callId;
              console.error(`Associated WebSocket with call ${callId}`);
              break;
            }
          }
        }

        // Forward audio to realtime transcription session
        if (associatedCallId) {
          const state = this.activeCalls.get(associatedCallId);
          if (state?.sttSession) {
            const audioData = this.extractInboundAudio(msgBuffer);
            if (audioData) {
              state.sttSession.sendAudio(audioData);
            }
          }
        }
      });

      ws.on('close', () => {
        console.error('Media stream WebSocket closed');
      });
    });

    this.httpServer.listen(this.config.port, () => {
      console.error(`HTTP server listening on port ${this.config.port}`);
    });
  }

  /**
   * Extract INBOUND audio data from WebSocket message (filters out outbound/TTS audio)
   */
  private extractInboundAudio(msgBuffer: Buffer): Buffer | null {
    if (msgBuffer.length === 0) return null;

    // Binary audio (doesn't start with '{') - can't determine track, skip
    if (msgBuffer[0] !== 0x7b) {
      return null;
    }

    // JSON format - only extract inbound track (user's voice)
    try {
      const msg = JSON.parse(msgBuffer.toString());
      if (msg.event === 'media' && msg.media?.payload) {
        const track = msg.media?.track;
        if (track === 'inbound' || track === 'inbound_track') {
          return Buffer.from(msg.media.payload, 'base64');
        }
      }
    } catch {}

    return null;
  }

  private handlePhoneWebhook(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers['content-type'] || '';

    // Telnyx sends JSON webhooks
    if (contentType.includes('application/json')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          await this.handleTelnyxWebhook(event, res);
        } catch (error) {
          console.error('Error parsing webhook:', error);
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
      return;
    }

    // Twilio sends form-urlencoded webhooks
    if (contentType.includes('application/x-www-form-urlencoded')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = new URLSearchParams(body);
          await this.handleTwilioWebhook(params, res);
        } catch (error) {
          console.error('Error parsing Twilio webhook:', error);
          res.writeHead(400);
          res.end('Invalid form data');
        }
      });
      return;
    }

    // Fallback: Return TwiML for media stream connection
    const streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
    const xml = this.config.providers.phone.getStreamConnectXml(streamUrl);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  }

  private async handleTwilioWebhook(params: URLSearchParams, res: ServerResponse): Promise<void> {
    const callSid = params.get('CallSid');
    const callStatus = params.get('CallStatus');

    console.error(`Twilio webhook: CallSid=${callSid}, CallStatus=${callStatus}`);

    // Handle call status updates
    if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
      // Call ended - find and mark as hung up
      if (callSid) {
        const callId = this.callControlIdToCallId.get(callSid);
        if (callId) {
          this.callControlIdToCallId.delete(callSid);
          const state = this.activeCalls.get(callId);
          if (state) {
            state.hungUp = true;
            state.ws?.close();
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    // For 'in-progress' or 'ringing' status, return TwiML to start media stream
    const streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
    const xml = this.config.providers.phone.getStreamConnectXml(streamUrl);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  }

  private async handleTelnyxWebhook(event: any, res: ServerResponse): Promise<void> {
    const eventType = event.data?.event_type;
    const callControlId = event.data?.payload?.call_control_id;

    console.error(`Phone webhook: ${eventType}`);

    // Always respond 200 OK immediately
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));

    if (!callControlId) return;

    try {
      switch (eventType) {
        case 'call.initiated':
          break;

        case 'call.answered':
          const streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
          await this.config.providers.phone.startStreaming(callControlId, streamUrl);
          console.error(`Started streaming for call ${callControlId}`);
          break;

        case 'call.hangup':
          const callId = this.callControlIdToCallId.get(callControlId);
          if (callId) {
            this.callControlIdToCallId.delete(callControlId);
            const state = this.activeCalls.get(callId);
            if (state) {
              state.hungUp = true;
              state.ws?.close();
            }
          }
          break;

        case 'call.machine.detection.ended':
          const result = event.data?.payload?.result;
          console.error(`AMD result: ${result}`);
          break;

        case 'streaming.started':
        case 'streaming.stopped':
          break;
      }
    } catch (error) {
      console.error(`Error handling webhook ${eventType}:`, error);
    }
  }

  async initiateCall(message: string): Promise<{ callId: string; response: string }> {
    const callId = `call-${++this.currentCallId}-${Date.now()}`;

    // Create realtime transcription session via provider
    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();
    console.error(`[${callId}] STT session connected`);

    const state: CallState = {
      callId,
      callControlId: null,
      userPhoneNumber: this.config.userPhoneNumber,
      ws: null,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
    };

    this.activeCalls.set(callId, state);

    try {
      const callControlId = await this.config.providers.phone.initiateCall(
        this.config.userPhoneNumber,
        this.config.phoneNumber,
        `${this.config.publicUrl}/twiml`
      );

      state.callControlId = callControlId;
      this.callControlIdToCallId.set(callControlId, callId);

      console.error(`Call initiated: ${callControlId} -> ${this.config.userPhoneNumber}`);

      await this.waitForConnection(callId, 15000);

      const response = await this.speakAndListen(state, message);
      state.conversationHistory.push({ speaker: 'claude', message });
      state.conversationHistory.push({ speaker: 'user', message: response });

      return { callId, response };
    } catch (error) {
      state.sttSession?.close();
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async continueCall(callId: string, message: string): Promise<string> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    const response = await this.speakAndListen(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  async speakOnly(callId: string, message: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    await this.speak(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
  }

  async endCall(callId: string, message: string): Promise<{ durationSeconds: number }> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    await this.speak(state, message);

    // Hang up the call via phone provider
    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }

    // Close sessions
    state.sttSession?.close();
    state.ws?.close();
    state.hungUp = true;

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
    this.activeCalls.delete(callId);

    return { durationSeconds };
  }

  private async waitForConnection(callId: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const state = this.activeCalls.get(callId);
      if (state?.ws && state.ws.readyState === WebSocket.OPEN) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('WebSocket connection timeout');
  }

  private async speakAndListen(state: CallState, text: string): Promise<string> {
    await this.speak(state, text);
    return await this.listen(state);
  }

  private async speak(state: CallState, text: string): Promise<void> {
    console.error(`[${state.callId}] Speaking: ${text.substring(0, 50)}...`);

    const tts = this.config.providers.tts;

    // Use streaming if available for lower latency
    if (tts.synthesizeStream) {
      await this.speakStreaming(state, text, tts.synthesizeStream.bind(tts));
    } else {
      const pcmData = await tts.synthesize(text);
      await this.sendAudio(state, pcmData);
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    console.error(`[${state.callId}] Speaking done`);
  }

  private async speakStreaming(
    state: CallState,
    text: string,
    synthesizeStream: (text: string) => AsyncGenerator<Buffer>
  ): Promise<void> {
    let pendingPcm = Buffer.alloc(0);
    let pendingMuLaw = Buffer.alloc(0);
    const OUTPUT_CHUNK_SIZE = 160; // 20ms at 8kHz
    const SAMPLES_PER_RESAMPLE = 6; // 6 bytes (3 samples) at 24kHz -> 1 sample at 8kHz

    for await (const chunk of synthesizeStream(text)) {
      pendingPcm = Buffer.concat([pendingPcm, chunk]);

      const completeUnits = Math.floor(pendingPcm.length / SAMPLES_PER_RESAMPLE);
      if (completeUnits > 0) {
        const bytesToProcess = completeUnits * SAMPLES_PER_RESAMPLE;
        const toProcess = pendingPcm.subarray(0, bytesToProcess);
        pendingPcm = pendingPcm.subarray(bytesToProcess);

        const resampled = this.resample24kTo8k(toProcess);
        const muLaw = this.pcmToMuLaw(resampled);
        pendingMuLaw = Buffer.concat([pendingMuLaw, muLaw]);

        while (pendingMuLaw.length >= OUTPUT_CHUNK_SIZE) {
          const audioChunk = pendingMuLaw.subarray(0, OUTPUT_CHUNK_SIZE);
          pendingMuLaw = pendingMuLaw.subarray(OUTPUT_CHUNK_SIZE);

          if (state.ws?.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
              event: 'media',
              media: { payload: audioChunk.toString('base64') },
            }));
          }
          await new Promise((resolve) => setTimeout(resolve, 18));
        }
      }
    }

    // Send remaining audio
    if (pendingMuLaw.length > 0 && state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        event: 'media',
        media: { payload: pendingMuLaw.toString('base64') },
      }));
    }
  }

  private async sendAudio(state: CallState, pcmData: Buffer): Promise<void> {
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);

    const chunkSize = 160;
    for (let i = 0; i < muLawData.length; i += chunkSize) {
      const chunk = muLawData.subarray(i, i + chunkSize);
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          event: 'media',
          media: { payload: chunk.toString('base64') },
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 18));
    }
  }

  private async listen(state: CallState): Promise<string> {
    console.error(`[${state.callId}] Listening...`);

    if (!state.sttSession) {
      throw new Error('STT session not available');
    }

    const transcript = await state.sttSession.waitForTranscript(this.config.transcriptTimeoutMs);

    if (state.hungUp) {
      throw new Error('Call was hung up by user');
    }

    console.error(`[${state.callId}] User said: ${transcript}`);
    return transcript;
  }

  private resample24kTo8k(pcmData: Buffer): Buffer {
    const inputSamples = pcmData.length / 2;
    const outputSamples = Math.floor(inputSamples / 3);
    const output = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
      const sample = pcmData.readInt16LE(i * 3 * 2);
      output.writeInt16LE(sample, i * 2);
    }

    return output;
  }

  private pcmToMuLaw(pcmData: Buffer): Buffer {
    const muLawData = Buffer.alloc(Math.floor(pcmData.length / 2));
    for (let i = 0; i < muLawData.length; i++) {
      const pcm = pcmData.readInt16LE(i * 2);
      muLawData[i] = this.pcmToMuLawSample(pcm);
    }
    return muLawData;
  }

  private pcmToMuLawSample(pcm: number): number {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (pcm >> 8) & 0x80;
    if (sign) pcm = -pcm;
    if (pcm > CLIP) pcm = CLIP;
    pcm += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--) {
      expMask >>= 1;
    }
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }

  getHttpServer() {
    return this.httpServer;
  }

  shutdown(): void {
    for (const callId of this.activeCalls.keys()) {
      this.endCall(callId, 'Goodbye!').catch(console.error);
    }
    this.wss?.close();
    this.httpServer?.close();
  }
}
