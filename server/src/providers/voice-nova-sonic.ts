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
 * - Input:  PCM 16-bit mono 16kHz
 * - Output: PCM 16-bit mono 24kHz
 *
 * Model IDs:
 * - amazon.nova-sonic-v1:0 (original)
 * - amazon.nova-2-sonic-v1:0 (Nova 2 Sonic, Dec 2025)
 *
 * @see https://docs.aws.amazon.com/nova/latest/userguide/speech.html
 * @see https://docs.aws.amazon.com/nova/latest/userguide/speech-bidirection.html
 * @see https://github.com/aws-samples/amazon-nova-samples/tree/main/speech-to-speech
 */

export interface NovaSonicConfig {
  region: string;
  modelId: string;
  voiceId: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface NovaSonicSession {
  /**
   * Start the bidirectional stream session
   */
  connect(): Promise<void>;

  /**
   * Send PCM audio chunk (16kHz 16-bit mono) to Nova Sonic
   */
  sendAudio(pcmData: Buffer): void;

  /**
   * Send a text message (e.g., system prompt update, tool result)
   */
  sendText(text: string, role?: 'SYSTEM' | 'USER'): void;

  /**
   * Send tool result back to Nova Sonic
   */
  sendToolResult(toolUseId: string, result: string): Promise<void>;

  /**
   * Register callback for audio output (24kHz PCM)
   */
  onAudioOutput(callback: (audio: Buffer) => void): void;

  /**
   * Register callback for text transcripts
   */
  onTextOutput(callback: (text: string, role: string) => void): void;

  /**
   * Register callback for tool use requests
   */
  onToolUse(callback: (toolName: string, toolUseId: string, input: any) => void): void;

  /**
   * Register callback for turn completion (user finished speaking)
   */
  onTurnComplete(callback: (transcript: string) => void): void;

  /**
   * Close the session
   */
  close(): void;

  /**
   * Check if connected
   */
  isConnected(): boolean;
}

/**
 * Nova Sonic Voice Provider
 *
 * TODO: Implement using @aws-sdk/client-bedrock-runtime
 *       InvokeModelWithBidirectionalStream API
 *
 * The implementation will:
 * 1. Create a BedrockRuntimeClient with HTTP/2 config
 * 2. Call invokeModelWithBidirectionalStream() to open the stream
 * 3. Send sessionStart event with voice config and system prompt
 * 4. Forward phone audio (converted from mu-law 8kHz to PCM 16kHz) as audioInput events
 * 5. Receive audioOutput events and convert back to mu-law 8kHz for phone
 * 6. Handle textOutput events for transcripts
 * 7. Handle toolUse events for MCP tool integration
 *
 * Key integration point with Twilio:
 * - Twilio Media Stream sends mu-law 8kHz audio via WebSocket
 * - We convert: mu-law 8kHz -> PCM 16kHz (for Nova Sonic input)
 * - Nova Sonic outputs: PCM 24kHz -> resample to 8kHz -> mu-law (for Twilio)
 *
 * This is a significant architectural change from the original call-me:
 * - Original: Phone -> STT (OpenAI) -> text -> TTS (OpenAI) -> Phone
 * - Nova Sonic: Phone -> Nova Sonic (speech-to-speech) -> Phone
 *   The model handles the entire conversation natively in audio space.
 */
export class NovaSonicProvider {
  readonly name = 'nova-sonic';
  private config: NovaSonicConfig | null = null;

  initialize(config: NovaSonicConfig): void {
    this.config = config;
    console.error(`Voice provider: Nova Sonic (${config.modelId}, voice: ${config.voiceId}, region: ${config.region})`);
  }

  createSession(): NovaSonicSession {
    if (!this.config) throw new Error('Nova Sonic not initialized');

    // TODO: Implement NovaSonicSessionImpl
    // Will use @aws-sdk/client-bedrock-runtime (or the experimental Python-style SDK)
    // See: https://github.com/aws-samples/amazon-nova-samples/tree/main/speech-to-speech
    throw new Error('Nova Sonic session not yet implemented - coming soon!');
  }
}

/**
 * Audio conversion utilities for Nova Sonic <-> Twilio bridge
 */
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

// mu-law codec helpers
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
