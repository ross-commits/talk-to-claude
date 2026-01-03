export interface Config {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  userPhoneNumber: string;
  openaiApiKey: string;
  serverPort: number;
  publicUrl: string;
}

export function loadConfig(): Config {
  const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'USER_PHONE_NUMBER',
    'OPENAI_API_KEY',
    'PUBLIC_URL'
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n\n` +
      'Please set these in your .env file or environment.'
    );
  }

  return {
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER!,
    userPhoneNumber: process.env.USER_PHONE_NUMBER!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    serverPort: parseInt(process.env.PORT || '3000', 10),
    publicUrl: process.env.PUBLIC_URL!
  };
}

export function validatePhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');

  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+${cleaned}`;
  } else if (phone.startsWith('+')) {
    return phone;
  }

  throw new Error(`Invalid phone number format: ${phone}`);
}
