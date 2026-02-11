/**
 * Provider Factory
 *
 * Creates and configures providers based on environment variables.
 * Supports three voice backends: Nova Sonic, OpenAI, and self-hosted.
 * Phone: Twilio (primary) or Telnyx.
 */

import type { PhoneProvider, TTSProvider, RealtimeSTTProvider, ProviderRegistry } from './types.js';
import { TelnyxPhoneProvider } from './phone-telnyx.js';
import { TwilioPhoneProvider } from './phone-twilio.js';
import { OpenAITTSProvider } from './tts-openai.js';
import { OpenAIRealtimeSTTProvider } from './stt-openai-realtime.js';
import { SelfHostedTTSProvider } from './tts-self-hosted.js';
import { SelfHostedSTTProvider } from './stt-self-hosted.js';

export * from './types.js';

export type PhoneProviderType = 'telnyx' | 'twilio';
export type VoiceBackend = 'nova-sonic' | 'openai' | 'self-hosted';

export interface ProviderConfig {
  // Phone provider selection
  phoneProvider: PhoneProviderType;

  // Phone credentials (interpretation depends on provider)
  // Telnyx: accountSid = Connection ID, authToken = API Key
  // Twilio: accountSid = Account SID, authToken = Auth Token
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;

  // Telnyx webhook public key (for signature verification)
  telnyxPublicKey?: string;

  // Voice backend selection
  voiceBackend: VoiceBackend;

  // OpenAI (TTS + STT) - used when voiceBackend is 'openai'
  openaiApiKey: string;
  ttsVoice?: string;
  sttModel?: string;
  sttSilenceDurationMs?: number;

  // Nova Sonic - used when voiceBackend is 'nova-sonic'
  awsRegion?: string;
  novaSonicModel?: string;
  novaSonicVoice?: string;

  // Self-hosted - used when voiceBackend is 'self-hosted'
  selfHostedSttUrl?: string;
  selfHostedTtsUrl?: string;
}

export function loadProviderConfig(): ProviderConfig {
  const sttSilenceDurationMs = process.env.TTC_STT_SILENCE_DURATION_MS
    ? parseInt(process.env.TTC_STT_SILENCE_DURATION_MS, 10)
    : undefined;

  // Default to twilio
  const phoneProvider = (process.env.TTC_PHONE_PROVIDER || 'twilio') as PhoneProviderType;

  // Default to nova-sonic
  const voiceBackend = (process.env.TTC_VOICE_BACKEND || 'nova-sonic') as VoiceBackend;

  return {
    phoneProvider,
    voiceBackend,
    phoneAccountSid: process.env.TTC_PHONE_ACCOUNT_SID || '',
    phoneAuthToken: process.env.TTC_PHONE_AUTH_TOKEN || '',
    phoneNumber: process.env.TTC_PHONE_NUMBER || '',
    telnyxPublicKey: process.env.TTC_TELNYX_PUBLIC_KEY,
    openaiApiKey: process.env.TTC_OPENAI_API_KEY || '',
    ttsVoice: process.env.TTC_TTS_VOICE || 'onyx',
    sttModel: process.env.TTC_STT_MODEL || 'gpt-4o-transcribe',
    sttSilenceDurationMs,
    awsRegion: process.env.TTC_AWS_REGION || 'us-east-1',
    novaSonicModel: process.env.TTC_NOVA_SONIC_MODEL || 'amazon.nova-2-sonic-v1:0',
    novaSonicVoice: process.env.TTC_NOVA_SONIC_VOICE || 'matthew',
    selfHostedSttUrl: process.env.TTC_SELF_HOSTED_STT_URL,
    selfHostedTtsUrl: process.env.TTC_SELF_HOSTED_TTS_URL,
  };
}

export function createPhoneProvider(config: ProviderConfig): PhoneProvider {
  let provider: PhoneProvider;

  if (config.phoneProvider === 'twilio') {
    provider = new TwilioPhoneProvider();
  } else {
    provider = new TelnyxPhoneProvider();
  }

  provider.initialize({
    accountSid: config.phoneAccountSid,
    authToken: config.phoneAuthToken,
    phoneNumber: config.phoneNumber,
  });

  return provider;
}

export function createTTSProvider(config: ProviderConfig): TTSProvider {
  if (config.voiceBackend === 'nova-sonic') {
    // Nova Sonic handles TTS internally via bidirectional stream.
    // Return a stub provider — the CallManager bypasses it entirely
    // when using Nova Sonic, but the ProviderRegistry type requires one.
    return {
      name: 'nova-sonic (native)',
      initialize() {},
      async synthesize() { return Buffer.alloc(0); },
    } as TTSProvider;
  }

  if (config.voiceBackend === 'self-hosted') {
    const provider = new SelfHostedTTSProvider();
    provider.initialize({
      serverUrl: config.selfHostedTtsUrl!,
      voice: config.novaSonicVoice,
      model: 'kokoro',
    });
    return provider;
  }

  // OpenAI TTS
  const provider = new OpenAITTSProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    voice: config.ttsVoice,
  });
  return provider;
}

export function createSTTProvider(config: ProviderConfig): RealtimeSTTProvider {
  if (config.voiceBackend === 'nova-sonic') {
    // Nova Sonic handles STT internally via bidirectional stream.
    // Return a stub provider — the CallManager bypasses it entirely
    // when using Nova Sonic, but the ProviderRegistry type requires one.
    return {
      name: 'nova-sonic (native)',
      initialize() {},
      createSession() { throw new Error('Nova Sonic handles STT natively'); },
    } as RealtimeSTTProvider;
  }

  if (config.voiceBackend === 'self-hosted') {
    const provider = new SelfHostedSTTProvider();
    provider.initialize({
      serverUrl: config.selfHostedSttUrl!,
      silenceDurationMs: config.sttSilenceDurationMs,
    });
    return provider;
  }

  // OpenAI Realtime STT
  const provider = new OpenAIRealtimeSTTProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    model: config.sttModel,
    silenceDurationMs: config.sttSilenceDurationMs,
  });
  return provider;
}

export function createProviders(config: ProviderConfig): ProviderRegistry {
  return {
    phone: createPhoneProvider(config),
    tts: createTTSProvider(config),
    stt: createSTTProvider(config),
  };
}

/**
 * Validate that required config is present
 */
export function validateProviderConfig(config: ProviderConfig): string[] {
  const errors: string[] = [];

  // Provider-specific credential descriptions
  const credentialDesc = config.phoneProvider === 'twilio'
    ? { accountSid: 'Twilio Account SID', authToken: 'Twilio Auth Token' }
    : { accountSid: 'Telnyx Connection ID', authToken: 'Telnyx API Key' };

  if (!config.phoneAccountSid) {
    errors.push(`Missing TTC_PHONE_ACCOUNT_SID (${credentialDesc.accountSid})`);
  }
  if (!config.phoneAuthToken) {
    errors.push(`Missing TTC_PHONE_AUTH_TOKEN (${credentialDesc.authToken})`);
  }
  if (!config.phoneNumber) {
    errors.push('Missing TTC_PHONE_NUMBER');
  }

  // Voice backend-specific validation
  if (config.voiceBackend === 'openai') {
    if (!config.openaiApiKey) {
      errors.push('Missing TTC_OPENAI_API_KEY (required for openai voice backend)');
    }
  } else if (config.voiceBackend === 'self-hosted') {
    if (!config.selfHostedSttUrl) {
      errors.push('Missing TTC_SELF_HOSTED_STT_URL (required for self-hosted voice backend)');
    }
    if (!config.selfHostedTtsUrl) {
      errors.push('Missing TTC_SELF_HOSTED_TTS_URL (required for self-hosted voice backend)');
    }
  }
  // nova-sonic uses AWS credentials from environment (aws configure), no env var needed here

  return errors;
}
