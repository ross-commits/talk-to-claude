/**
 * AWS Nova Sonic Voice Provider
 *
 * Speech-to-speech via Amazon Bedrock's InvokeModelWithBidirectionalStream API.
 * Replaces both STT and TTS with a single unified model that natively
 * understands and generates speech.
 *
 * Nova Sonic handles:
 * - Real-time bidirectional audio streaming (HTTP/2)
 * - Voice activity detection (VAD) and turn detection
 * - Barge-in (interruption) support
 * - Tool use / function calling mid-conversation
 * - Text transcripts of both sides
 *
 * Audio formats:
 * - Input:  PCM 16-bit mono 16kHz (base64 encoded in JSON events)
 * - Output: PCM 16-bit mono 24kHz (base64 encoded in JSON events)
 *
 * Model IDs:
 * - amazon.nova-sonic-v1:0 (original)
 * - amazon.nova-2-sonic-v1:0 (Nova 2 Sonic, Dec 2025)
 *
 * @see https://docs.aws.amazon.com/nova/latest/userguide/speech.html
 * @see https://github.com/aws-samples/sample-sonic-sip-server-js
 * @see https://github.com/aws-samples/amazon-nova-samples/tree/main/speech-to-speech
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface NovaSonicConfig {
  region: string;
  modelId: string;
  voiceId: string;
  systemPrompt?: string;
  toolConfiguration?: ToolConfiguration;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful voice assistant called Claude, built by Anthropic. ' +
  'You are speaking with a user on a phone call. Keep responses concise and conversational. ' +
  'If you don\'t understand something, ask for clarification.';

// ---------------------------------------------------------------------------
// Session interface
// ---------------------------------------------------------------------------

export interface NovaSonicSession {
  /** Start the bidirectional stream session */
  connect(): Promise<void>;

  /** Send PCM audio chunk (16kHz 16-bit mono) to Nova Sonic */
  sendAudio(pcmData: Buffer): void;

  /** Send a text message (injected as user text, not audio) */
  sendText(text: string, role?: 'SYSTEM' | 'USER'): void;

  /** Send tool result back to Nova Sonic */
  sendToolResult(toolUseId: string, result: string): void;

  /** Register callback for audio output (24kHz PCM) */
  onAudioOutput(callback: (audio: Buffer) => void): void;

  /** Register callback for text transcripts */
  onTextOutput(callback: (text: string, role: string) => void): void;

  /** Register callback for tool use requests */
  onToolUse(callback: (toolName: string, toolUseId: string, input: any) => void): void;

  /** Register callback for turn completion */
  onTurnComplete(callback: () => void): void;

  /** Register callback for barge-in (user interrupted model output) */
  onInterruption(callback: () => void): void;

  /** Close the session gracefully */
  close(): void;

  /** Check if connected */
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * NovaSonicSessionImpl manages a single bidirectional streaming conversation
 * with Amazon Nova Sonic via Bedrock.
 *
 * Architecture:
 * - An async iterable feeds events to the Bedrock stream (outbound)
 * - A response loop processes events from the Bedrock stream (inbound)
 * - Two queues: control events (priority) and audio events (sent only when
 *   model is not actively outputting audio, to support barge-in)
 */
class NovaSonicSessionImpl implements NovaSonicSession {
  private config: NovaSonicConfig;
  private client: BedrockRuntimeClient;

  // Stream state
  private active = false;
  private connected = false;

  // Event queues for the async iterable (outbound to Nova Sonic)
  private controlQueue: any[] = [];    // Non-audio events (priority)
  private audioQueue: any[] = [];      // Audio input events
  private queueResolve: (() => void) | null = null;  // Resolve waiting iterator
  private closeRequested = false;

  // Model output state (for barge-in / audio gating)
  private modelSpeaking = false;

  // UUIDs for the session
  private promptName: string;
  private systemContentName: string;
  private audioContentName: string;

  // Callbacks
  private audioOutputCb: ((audio: Buffer) => void) | null = null;
  private textOutputCb: ((text: string, role: string) => void) | null = null;
  private toolUseCb: ((toolName: string, toolUseId: string, input: any) => void) | null = null;
  private turnCompleteCb: (() => void) | null = null;
  private interruptionCb: (() => void) | null = null;

  // Pending tool use accumulation
  private pendingToolUse: { toolUseId: string; toolName: string; content: string } | null = null;

  constructor(config: NovaSonicConfig, client: BedrockRuntimeClient) {
    this.config = config;
    this.client = client;
    this.promptName = crypto.randomUUID();
    this.systemContentName = crypto.randomUUID();
    this.audioContentName = crypto.randomUUID();
  }

  // -- Public API -----------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;

    this.active = true;
    this.connected = true;

    // Queue the session setup events BEFORE calling send()
    // The async iterable will yield them in order.
    this.queueSessionSetup();

    // Create the bidirectional stream
    const asyncIterable = this.createAsyncIterable();
    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: this.config.modelId,
      body: asyncIterable,
    });

    try {
      const response = await this.client.send(command);

      // Process response stream in the background (don't await — it runs
      // for the lifetime of the session)
      this.processResponseStream(response).catch((err) => {
        if (this.active) {
          console.error('[Nova Sonic] Response stream error:', err);
        }
      });

      console.error('[Nova Sonic] Session connected');
    } catch (err) {
      this.active = false;
      this.connected = false;
      throw err;
    }
  }

  sendAudio(pcmData: Buffer): void {
    if (!this.active) return;

    const base64 = pcmData.toString('base64');
    this.enqueueAudio({
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: base64,
        },
      },
    });
  }

  sendText(text: string, role: 'SYSTEM' | 'USER' = 'USER'): void {
    if (!this.active) return;

    const contentName = crypto.randomUUID();

    this.enqueueControl({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName,
          type: 'TEXT',
          interactive: true,  // Nova 2 Sonic: cross-modal text during active voice session
          role,
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });

    this.enqueueControl({
      event: {
        textInput: {
          promptName: this.promptName,
          contentName,
          content: text,
        },
      },
    });

    this.enqueueControl({
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName,
        },
      },
    });
  }

  sendToolResult(toolUseId: string, result: string): void {
    if (!this.active) return;

    const contentName = crypto.randomUUID();

    this.enqueueControl({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName,
          interactive: false,
          type: 'TOOL',
          role: 'TOOL',
          toolResultInputConfiguration: {
            toolUseId,
            type: 'TEXT',
            textInputConfiguration: { mediaType: 'text/plain' },
          },
        },
      },
    });

    this.enqueueControl({
      event: {
        toolResult: {
          promptName: this.promptName,
          contentName,
          content: result,
        },
      },
    });

    this.enqueueControl({
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName,
        },
      },
    });
  }

  onAudioOutput(callback: (audio: Buffer) => void): void {
    this.audioOutputCb = callback;
  }

  onTextOutput(callback: (text: string, role: string) => void): void {
    this.textOutputCb = callback;
  }

  onToolUse(callback: (toolName: string, toolUseId: string, input: any) => void): void {
    this.toolUseCb = callback;
  }

  onTurnComplete(callback: () => void): void {
    this.turnCompleteCb = callback;
  }

  onInterruption(callback: () => void): void {
    this.interruptionCb = callback;
  }

  close(): void {
    if (!this.active) return;
    this.active = false;

    // Send graceful close sequence
    try {
      // Close audio content
      this.enqueueControl({
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: this.audioContentName,
          },
        },
      });

      // End prompt
      this.enqueueControl({
        event: {
          promptEnd: {
            promptName: this.promptName,
          },
        },
      });

      // End session
      this.enqueueControl({
        event: {
          sessionEnd: {},
        },
      });
    } catch {
      // Best-effort cleanup
    }

    // Signal the iterator to finish after draining
    this.closeRequested = true;
    this.signalQueue();

    // Mark disconnected after a brief drain period
    setTimeout(() => {
      this.connected = false;
    }, 500);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -- Session setup --------------------------------------------------------

  private queueSessionSetup(): void {
    const cfg = this.config;

    // 1. sessionStart
    this.enqueueControl({
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: cfg.maxTokens ?? 1024,
            topP: cfg.topP ?? 0.9,
            temperature: cfg.temperature ?? 0.7,
          },
        },
      },
    });

    // 2. promptStart (with output config, voice, and optional tools)
    const promptStart: Record<string, any> = {
      promptName: this.promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: {
        audioType: 'SPEECH',
        encoding: 'base64',
        mediaType: 'audio/lpcm',
        sampleRateHertz: 24000,  // 24kHz output
        sampleSizeBits: 16,
        channelCount: 1,
        voiceId: cfg.voiceId,
      },
    };

    if (cfg.toolConfiguration?.tools?.length) {
      promptStart.toolConfiguration = cfg.toolConfiguration;
    }

    this.enqueueControl({
      event: { promptStart },
    });

    // 3. System prompt: contentStart(TEXT, SYSTEM) -> textInput -> contentEnd
    this.enqueueControl({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: this.systemContentName,
          type: 'TEXT',
          interactive: false,
          role: 'SYSTEM',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });

    this.enqueueControl({
      event: {
        textInput: {
          promptName: this.promptName,
          contentName: this.systemContentName,
          content: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        },
      },
    });

    this.enqueueControl({
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName: this.systemContentName,
        },
      },
    });

    // 4. Open audio content stream (USER, interactive)
    this.enqueueControl({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          type: 'AUDIO',
          interactive: true,
          role: 'USER',
          audioInputConfiguration: {
            audioType: 'SPEECH',
            encoding: 'base64',
            mediaType: 'audio/lpcm',
            sampleRateHertz: 16000,  // 16kHz input
            sampleSizeBits: 16,
            channelCount: 1,
          },
        },
      },
    });
  }

  // -- Outbound event queue & async iterable --------------------------------

  private enqueueControl(event: any): void {
    this.controlQueue.push(event);
    this.signalQueue();
  }

  private enqueueAudio(event: any): void {
    this.audioQueue.push(event);
    this.signalQueue();
  }

  private signalQueue(): void {
    if (this.queueResolve) {
      const resolve = this.queueResolve;
      this.queueResolve = null;
      resolve();
    }
  }

  private waitForQueue(): Promise<void> {
    return new Promise((resolve) => {
      this.queueResolve = resolve;
    });
  }

  /**
   * Creates the async iterable that feeds events to the Bedrock stream.
   * Control events always take priority over audio events.
   * Audio events are only sent when the model is NOT actively outputting
   * (to support barge-in behavior).
   */
  private createAsyncIterable() {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<any>> {
            // Wait for events if both queues are empty
            while (
              self.controlQueue.length === 0 &&
              self.audioQueue.length === 0 &&
              !self.closeRequested
            ) {
              await self.waitForQueue();
            }

            // Drain control events first (priority)
            if (self.controlQueue.length > 0) {
              const event = self.controlQueue.shift()!;
              return {
                value: {
                  chunk: {
                    bytes: new TextEncoder().encode(JSON.stringify(event)),
                  },
                },
                done: false,
              };
            }

            // Send audio only when model is not speaking
            if (self.audioQueue.length > 0 && !self.modelSpeaking) {
              const event = self.audioQueue.shift()!;
              return {
                value: {
                  chunk: {
                    bytes: new TextEncoder().encode(JSON.stringify(event)),
                  },
                },
                done: false,
              };
            }

            // If close was requested and queues are drained, end the stream
            if (self.closeRequested && self.controlQueue.length === 0) {
              return { value: undefined, done: true };
            }

            // Audio queue has items but model is speaking — wait for signal
            await self.waitForQueue();
            return this.next();
          },

          async return(): Promise<IteratorResult<any>> {
            self.active = false;
            return { value: undefined, done: true };
          },

          async throw(error: any): Promise<IteratorResult<any>> {
            self.active = false;
            throw error;
          },
        };
      },
    };
  }

  // -- Inbound response processing ------------------------------------------

  private async processResponseStream(response: any): Promise<void> {
    const body = response.body;
    if (!body) {
      console.error('[Nova Sonic] No response body');
      return;
    }

    for await (const event of body) {
      if (!this.active && !this.closeRequested) break;

      if (event.chunk?.bytes) {
        const text = new TextDecoder().decode(event.chunk.bytes);
        try {
          const json = JSON.parse(text);
          this.handleResponseEvent(json);
        } catch (err) {
          console.error('[Nova Sonic] Failed to parse response event:', err);
        }
      } else if (event.modelStreamErrorException) {
        console.error('[Nova Sonic] Stream error:', event.modelStreamErrorException);
        break;
      } else if (event.internalServerException) {
        console.error('[Nova Sonic] Internal server error:', event.internalServerException);
        break;
      }
    }

    console.error('[Nova Sonic] Response stream ended');
    this.connected = false;
  }

  private handleResponseEvent(json: any): void {
    const evt = json.event;
    if (!evt) return;

    const eventType = Object.keys(evt)[0];

    switch (eventType) {
      case 'contentStart': {
        const cs = evt.contentStart;
        if (cs?.type === 'AUDIO' || cs?.role === 'ASSISTANT') {
          this.modelSpeaking = true;
        }
        break;
      }

      case 'audioOutput': {
        const audioB64 = evt.audioOutput?.content;
        if (audioB64 && this.audioOutputCb) {
          const pcmBuffer = Buffer.from(audioB64, 'base64');
          this.audioOutputCb(pcmBuffer);
        }
        break;
      }

      case 'textOutput': {
        const content = evt.textOutput?.content;
        const role = evt.textOutput?.role || 'ASSISTANT';
        if (content && this.textOutputCb) {
          this.textOutputCb(content, role);
        }
        break;
      }

      case 'toolUse': {
        const tu = evt.toolUse;
        if (tu) {
          // Accumulate tool use content — the toolUse event may arrive
          // in chunks; contentEnd with type TOOL signals completion
          this.pendingToolUse = {
            toolUseId: tu.toolUseId,
            toolName: tu.toolName,
            content: tu.content || '',
          };
        }
        break;
      }

      case 'contentEnd': {
        const ce = evt.contentEnd;

        // Model finished an audio/text output block
        if (this.modelSpeaking) {
          this.modelSpeaking = false;
          this.signalQueue();  // Unblock audio queue
        }

        // Check for barge-in (user interrupted)
        if (ce?.stopReason === 'INTERRUPTED') {
          console.error('[Nova Sonic] Barge-in detected');
          this.interruptionCb?.();
        }

        // Tool use completion
        if (ce?.type === 'TOOL' && this.pendingToolUse && this.toolUseCb) {
          const tu = this.pendingToolUse;
          this.pendingToolUse = null;
          let input: any;
          try {
            input = JSON.parse(tu.content);
          } catch {
            input = tu.content;
          }
          this.toolUseCb(tu.toolName, tu.toolUseId, input);
        }
        break;
      }

      case 'completionEnd': {
        // Model finished its entire response for this turn
        this.turnCompleteCb?.();
        break;
      }

      case 'completionStart':
      case 'usageEvent':
        // Informational — log usage for observability
        if (eventType === 'usageEvent') {
          const u = evt.usageEvent;
          console.error(`[Nova Sonic] Usage: ${u?.totalInputTokens ?? '?'} in / ${u?.totalOutputTokens ?? '?'} out`);
        }
        break;

      default:
        console.error(`[Nova Sonic] Unknown event: ${eventType}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider (factory)
// ---------------------------------------------------------------------------

export class NovaSonicProvider {
  readonly name = 'nova-sonic';
  private config: NovaSonicConfig | null = null;
  private client: BedrockRuntimeClient | null = null;

  initialize(config: NovaSonicConfig): void {
    this.config = config;

    // HTTP/2 is required for the bidirectional stream
    const http2Handler = new NodeHttp2Handler({
      requestTimeout: 300_000,      // 5 minutes
      sessionTimeout: 300_000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
    });

    this.client = new BedrockRuntimeClient({
      region: config.region,
      requestHandler: http2Handler,
    });

    console.error(
      `Voice provider: Nova Sonic (${config.modelId}, voice: ${config.voiceId}, region: ${config.region})`
    );
  }

  createSession(systemPrompt?: string, toolConfiguration?: ToolConfiguration): NovaSonicSession {
    if (!this.config || !this.client) {
      throw new Error('Nova Sonic not initialized — call initialize() first');
    }

    // Allow per-session overrides for system prompt and tools
    const sessionConfig = {
      ...this.config,
      ...(systemPrompt && { systemPrompt }),
      ...(toolConfiguration && { toolConfiguration }),
    };

    return new NovaSonicSessionImpl(sessionConfig, this.client);
  }
}

// ---------------------------------------------------------------------------
// Audio conversion utilities — mu-law 8kHz (Twilio) <-> PCM 16/24kHz (Nova)
// ---------------------------------------------------------------------------

export const NovaSonicAudio = {
  /**
   * Convert mu-law 8kHz (from Twilio) to PCM 16kHz (for Nova Sonic)
   * Steps: mu-law decode -> 8kHz PCM -> upsample 2x -> 16kHz PCM
   */
  mulawToNovaSonicPCM(mulawData: Buffer): Buffer {
    // Step 1: Decode mu-law to 16-bit PCM at 8kHz
    const pcm8k = Buffer.alloc(mulawData.length * 2);
    for (let i = 0; i < mulawData.length; i++) {
      pcm8k.writeInt16LE(mulawDecode(mulawData[i]), i * 2);
    }

    // Step 2: Upsample from 8kHz to 16kHz (linear interpolation)
    const pcm16k = Buffer.alloc(pcm8k.length * 2);
    const samples8k = pcm8k.length / 2;
    for (let i = 0; i < samples8k; i++) {
      const sample = pcm8k.readInt16LE(i * 2);
      const nextSample = i + 1 < samples8k ? pcm8k.readInt16LE((i + 1) * 2) : sample;
      const interpolated = Math.round((sample + nextSample) / 2);

      pcm16k.writeInt16LE(sample, i * 4);
      pcm16k.writeInt16LE(interpolated, i * 4 + 2);
    }

    return pcm16k;
  },

  /**
   * Convert PCM 24kHz (from Nova Sonic) to mu-law 8kHz (for Twilio)
   * Steps: 24kHz PCM -> downsample 3x -> 8kHz PCM -> mu-law encode
   */
  novaSonicPCMToMulaw(pcm24k: Buffer): Buffer {
    // Step 1: Downsample from 24kHz to 8kHz (3:1 with averaging)
    const inputSamples = pcm24k.length / 2;
    const outputSamples = Math.floor(inputSamples / 3);
    const pcm8k = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
      const baseIdx = i * 3;
      const s0 = pcm24k.readInt16LE(baseIdx * 2);
      const s1 = baseIdx + 1 < inputSamples ? pcm24k.readInt16LE((baseIdx + 1) * 2) : s0;
      const s2 = baseIdx + 2 < inputSamples ? pcm24k.readInt16LE((baseIdx + 2) * 2) : s1;
      pcm8k.writeInt16LE(Math.round((s0 + s1 + s2) / 3), i * 2);
    }

    // Step 2: Encode to mu-law
    const mulaw = Buffer.alloc(outputSamples);
    for (let i = 0; i < outputSamples; i++) {
      mulaw[i] = mulawEncode(pcm8k.readInt16LE(i * 2));
    }

    return mulaw;
  },
};

// ---------------------------------------------------------------------------
// mu-law codec helpers
// ---------------------------------------------------------------------------

function mulawDecode(mulaw: number): number {
  mulaw = ~mulaw;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function mulawEncode(pcm: number): number {
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
