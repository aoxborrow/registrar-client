import type { RegistrarCredentials, RegistrarEnvironment, RegistrarName } from '../../src/index';

// Describes how to assemble one registrar's SANDBOX credentials from env vars.
// `required` env vars must all be present for the target to be enabled;
// `optional` ones are included when set.
export interface SandboxTarget {
  name: RegistrarName;
  // credential field -> required env var
  required: Record<string, string>;
  // credential field -> optional env var
  optional?: Record<string, string>;
  // env var selecting the environment ("production" | "sandbox"); default sandbox
  environmentVar?: string;
}

// Registrars with a sandbox/test environment and the env vars they read.
// Set these (e.g. in a local .env) to enable that registrar's integration test.
export const SANDBOX_TARGETS: SandboxTarget[] = [
  {
    name: 'godaddy',
    // use GoDaddy OTE keys from developer.godaddy.com (OTE environment)
    required: { apiKey: 'GODADDY_API_KEY', apiSecret: 'GODADDY_API_SECRET' },
    environmentVar: 'GODADDY_ENVIRONMENT',
  },
  {
    name: 'namecheap',
    // sandbox account + key from sandbox.namecheap.com
    required: { username: 'NAMECHEAP_USERNAME', apiKey: 'NAMECHEAP_API_KEY' },
    optional: { clientIp: 'NAMECHEAP_CLIENT_IP' },
    environmentVar: 'NAMECHEAP_ENVIRONMENT',
  },
  {
    name: 'gandi',
    // sandbox key from the api.sandbox.gandi.net account
    required: { apiKey: 'GANDI_API_KEY' },
    environmentVar: 'GANDI_ENVIRONMENT',
  },
];

// Resolve the environment for a target from its env var, defaulting to sandbox
// (the integration suite targets sandbox; set the var to "production" to override).
export function loadEnvironment(target: SandboxTarget): RegistrarEnvironment {
  const value = target.environmentVar ? process.env[target.environmentVar] : undefined;
  return value === 'production' ? 'production' : 'sandbox';
}

// Build credentials for a target from the environment, or return null if any
// required env var is missing (so the test can skip).
export function loadSandboxCredentials(target: SandboxTarget): RegistrarCredentials | null {
  const creds: RegistrarCredentials = {};

  for (const [field, envVar] of Object.entries(target.required)) {
    const value = process.env[envVar];
    if (!value) return null;
    creds[field] = value;
  }

  for (const [field, envVar] of Object.entries(target.optional ?? {})) {
    const value = process.env[envVar];
    if (value) creds[field] = value;
  }

  return creds;
}
