#!/usr/bin/env bun

import { loadConfig } from './config.js';
import { PhoneService } from './phone-service.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Hey Boss - Phone Call Input Tool for Claude Code

Usage:
  hey-boss <question>
  hey-boss --help

Examples:
  hey-boss "Should I proceed with refactoring the authentication module?"
  hey-boss "Which API endpoint should I use for user data?"

Environment Variables Required:
  TWILIO_ACCOUNT_SID     - Twilio account SID
  TWILIO_AUTH_TOKEN      - Twilio auth token
  TWILIO_PHONE_NUMBER    - Your Twilio phone number (e.g., +1234567890)
  USER_PHONE_NUMBER      - Your personal phone number to call
  OPENAI_API_KEY         - OpenAI API key for voice conversation
  PUBLIC_URL             - Public URL where this server can be reached (e.g., https://your-domain.com)
  PORT                   - (Optional) Server port, default 3000

The tool will:
1. Call you on the phone
2. Explain what Claude Code needs
3. Listen to your response
4. Ask clarifying questions if needed
5. Return your answer to Claude Code
`);
    process.exit(0);
  }

  const question = args.join(' ');

  if (!question.trim()) {
    console.error('Error: Please provide a question');
    process.exit(1);
  }

  try {
    console.log('Loading configuration...');
    const config = loadConfig();

    console.log('Initiating phone call...');
    const phoneService = new PhoneService(config);

    const response = await phoneService.makeCall(question);

    console.log('\n========================================');
    console.log('USER RESPONSE:');
    console.log('========================================');
    console.log(response);
    console.log('========================================\n');

    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('Unknown error:', error);
    }
    process.exit(1);
  }
}

main();
