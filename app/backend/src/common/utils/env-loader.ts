import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import { join } from 'node:path';

/**
 * Precedence Rule:
 * OS environment variables always take precedence over variables defined in the .env files.
 * This is the default behavior of dotenv (it does not overwrite existing process.env variables).
 */
export function loadEnv(): string {
  const candidates = [
    join(process.cwd(), '.env'),
    join(process.cwd(), 'app', 'backend', '.env'),
    join(__dirname, '..', '..', '..', '.env'),
  ];

  const envPath = candidates.find(p => fs.existsSync(p));
  if (envPath) {
    dotenvConfig({ path: envPath });
    return envPath;
  }

  // Fallback to the first candidate if none exist, so NestJS ConfigModule has a default path
  return candidates[0];
}
