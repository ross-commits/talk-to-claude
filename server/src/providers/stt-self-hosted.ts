/**
 * Self-Hosted STT Provider
 *
 * Uses faster-whisper-server's batch REST API with client-side VAD.
 * Audio flow: mu-law 8kHz chunks from Twilio -> buffer -> silence detection ->
 *   convert to WAV -> POST /v1/audio/transcriptions -> transcript callback
 *
 * No WebSocket streaming needed — batch transcription with large-v3 on GPU
 * takes ~200-500ms for typical utterances (much faster than real-time).
 *
 * Recommended server: faster-whisper-server (fedirz/faster-whisper-server)
 *   docker run -d --gpus all -p 8000:8000 \
 *     fedirz/faster-whisper-server:latest \
 *     --model large-v3 --device cuda --compute_type int8
 */

import type { RealtimeSTTProvider, RealtimeSTTSession, STTConfig } from './types.js';

export interface SelfHostedSTTConfig extends STTConfig {
  /** Base URL of the STT server (e.g., http://your-gpu-server:8000) */
  serverUrl: string;
}

export class SelfHostedSTTProvider implements RealtimeSTTProvider {
  readonly name = 'self-hosted';
  private serverUrl: string = '';
  private silenceDurationMs: number = 800;

  initialize(config: STTConfig): void {
    const selfHostedConfig = config as SelfHostedSTTConfig;
    if (!selfHostedConfig.serverUrl) {
      throw new Error('TTC_SELF_HOSTED_STT_URL is required for self-hosted STT');
    }
    this.serverUrl = selfHostedConfig.serverUrl;
    this.silenceDurationMs = config.silenceDurationMs || 800;
    console.error(`STT provider: Self-hosted (${this.serverUrl}, silence: ${this.silenceDurationMs}ms)`);
  }

  createSession(): RealtimeSTTSession {
    return new SelfHostedSTTSession(this.serverUrl, this.silenceDurationMs);
  }
}

/**
 * mu-law decoding table (ITU-T G.711)
 * Converts 8-bit mu-law sample to 16-bit signed PCM
 */
const MULAW_DECODE_TABLE = new Int16Array(256);
(() => {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0f;
    mantissa = (mantissa << 1) | 1;
    mantissa = (mantissa << exponent) + (1 << exponent) - 1;
    mantissa = mantissa << 2;  // 14-bit -> 16-bit
    MULAW_DECODE_TABLE[i] = sign ? -mantissa : mantissa;
  }
})();

class SelfHostedSTTSession implements RealtimeSTTSession {
  private serverUrl: string;
  private silenceDurationMs: number;
  private _connected = false;

  // Audio buffering
  private audioChunks: Buffer[] = [];
  private totalSamples = 0;

  // VAD state — simple energy-based silence detection
  private isSpeaking = false;
  private silenceStartMs: number | null = null;
  private speechStarted = false;          // True once any speech detected in current turn
  private readonly ENERGY_THRESHOLD = 200; // RMS threshold for speech vs silence (mu-law decoded)
  private readonly MIN_SPEECH_MS = 300;    // Minimum speech duration before accepting silence
  private speechStartTime: number | null = null;

  // Transcript delivery
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private transcribing = false;  // Mutex to prevent concurrent transcriptions

  constructor(serverUrl: string, silenceDurationMs: number) {
    this.serverUrl = serverUrl;
    this.silenceDurationMs = silenceDurationMs;
  }

  async connect(): Promise<void> {
    // Verify server is reachable
    try {
      const resp = await fetch(`${this.serverUrl}/health`);
      if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`);
      this._connected = true;
      console.error('[SelfHostedSTT] Connected to server');
    } catch (error) {
      throw new Error(`Cannot reach STT server at ${this.serverUrl}: ${error}`);
    }
  }

  /**
   * Receive mu-law 8kHz audio chunk from Twilio.
   * Buffers audio and runs VAD to detect end of utterance.
   */
  sendAudio(muLawData: Buffer): void {
    if (!this._connected) return;

    this.audioChunks.push(muLawData);
    this.totalSamples += muLawData.length;

    // Calculate RMS energy of this chunk (decode mu-law to PCM for energy calc)
    let sumSquares = 0;
    for (let i = 0; i < muLawData.length; i++) {
      const pcmSample = MULAW_DECODE_TABLE[muLawData[i]];
      sumSquares += pcmSample * pcmSample;
    }
    const rms = Math.sqrt(sumSquares / muLawData.length);

    const now = Date.now();

    if (rms > this.ENERGY_THRESHOLD) {
      // Speech detected
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        if (!this.speechStarted) {
          this.speechStarted = true;
          this.speechStartTime = now;
          console.error('[SelfHostedSTT] Speech started');
        }
      }
      this.silenceStartMs = null;
    } else {
      // Silence
      if (this.isSpeaking) {
        this.isSpeaking = false;
        this.silenceStartMs = now;
      }

      // Check if silence duration exceeded (only after minimum speech duration)
      if (
        this.speechStarted &&
        this.silenceStartMs &&
        !this.transcribing &&
        this.speechStartTime &&
        (now - this.speechStartTime) >= this.MIN_SPEECH_MS &&
        (now - this.silenceStartMs) >= this.silenceDurationMs
      ) {
        console.error(`[SelfHostedSTT] Silence detected (${now - this.silenceStartMs}ms), transcribing...`);
        this.triggerTranscription();
      }
    }
  }

  /**
   * Convert buffered mu-law audio to WAV and send to faster-whisper
   */
  private async triggerTranscription(): Promise<void> {
    if (this.transcribing || this.audioChunks.length === 0) return;
    this.transcribing = true;

    // Grab current audio and reset buffer
    const chunks = this.audioChunks;
    this.audioChunks = [];
    this.totalSamples = 0;
    this.speechStarted = false;
    this.speechStartTime = null;
    this.silenceStartMs = null;
    this.isSpeaking = false;

    try {
      // Concatenate all mu-law chunks
      const muLawBuffer = Buffer.concat(chunks);

      // Decode mu-law to 16-bit PCM (8kHz)
      const pcmBuffer = Buffer.alloc(muLawBuffer.length * 2);
      for (let i = 0; i < muLawBuffer.length; i++) {
        pcmBuffer.writeInt16LE(MULAW_DECODE_TABLE[muLawBuffer[i]], i * 2);
      }

      // Create WAV header (PCM 16-bit mono 8kHz)
      const wavBuffer = this.createWavBuffer(pcmBuffer, 8000, 1, 16);

      const durationSec = muLawBuffer.length / 8000;
      console.error(`[SelfHostedSTT] Sending ${durationSec.toFixed(1)}s audio (${wavBuffer.length} bytes) for transcription`);

      // POST to faster-whisper
      const formData = new FormData();
      formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      formData.append('language', 'en');
      formData.append('response_format', 'json');

      const resp = await fetch(`${this.serverUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[SelfHostedSTT] Transcription failed: ${resp.status} ${errText}`);
        this.transcribing = false;
        return;
      }

      const result = await resp.json() as { text?: string };
      const transcript = result.text?.trim() || '';

      if (transcript) {
        console.error(`[SelfHostedSTT] Transcript: "${transcript}"`);
        this.onTranscriptCallback?.(transcript);
      } else {
        console.error('[SelfHostedSTT] Empty transcript (silence/noise only)');
      }
    } catch (error) {
      console.error('[SelfHostedSTT] Transcription error:', error);
    } finally {
      this.transcribing = false;
    }
  }

  /**
   * Create a WAV file buffer from raw PCM data
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const headerSize = 44;

    const header = Buffer.alloc(headerSize);
    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + headerSize - 8, 4);
    header.write('WAVE', 8);
    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);           // Sub-chunk size
    header.writeUInt16LE(1, 20);            // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  async waitForTranscript(timeoutMs: number = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.onTranscriptCallback = null;
        reject(new Error('Transcript timeout'));
      }, timeoutMs);

      this.onTranscriptCallback = (transcript) => {
        clearTimeout(timeout);
        this.onTranscriptCallback = null;
        resolve(transcript);
      };
    });
  }

  close(): void {
    this._connected = false;
    this.audioChunks = [];
    this.totalSamples = 0;
    this.onTranscriptCallback = null;
    this.onPartialCallback = null;
  }

  isConnected(): boolean {
    return this._connected;
  }
}
