import type { RegistrarCredentials, RegistrarName } from '../../src/index';

// Describes how to assemble one registrar's SANDBOX credentials from env vars.
// `required` env vars must all be present for the target to be enabled;
// `optional` ones are included when set.
export interface SandboxTarget {
  name: RegistrarName;
  // credential field -> required env var
  required: Record<string, string>;
  // credential field -> optional env var
  optional?: Record<string, string>;
}

// Registrars with a sandbox/test environment and the env vars they read.
// Set these (e.g. in a local .env) to enable that registrar's integration test.
export const SANDBOX_TARGETS: SandboxTarget[] = [
  {
    name: 'godaddy',
    // use GoDaddy OTE keys from developer.godaddy.com (OTE environment)
    required: { apiKey: 'GODADDY_API_KEY', apiSecret: 'GODADDY_API_SECRET' },
  },
  {
    name: 'namecheap',
    // sandbox account + key from sandbox.namecheap.com
    required: { username: 'NAMECHEAP_USERNAME', apiKey: 'NAMECHEAP_API_KEY' },
    optional: { clientIp: 'NAMECHEAP_CLIENT_IP' },
  },
  {
    name: 'gandi',
    // sandbox key from the api.sandbox.gandi.net account
    required: { apiKey: 'GANDI_API_KEY' },
  },
];

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
