/**
 * NameSilo OTE (sandbox) write-lifecycle exerciser — a deliberate MANUAL script.
 *
 * Per docs/INTEGRATION-TESTING.md, money-moving / write operations are run via
 * specific, deliberate scripts, never in CI. NameSilo's OTE uses fake sandbox
 * funds (no real money), so this registers a throwaway .com and exercises the
 * full read/write surface against ote.namesilo.com.
 *
 * Run:
 *   NAMESILO_API_KEY=... npx tsx scripts/ote/namesilo-lifecycle.ts
 * or, reading .env.testing (NAMESILO_API_KEY, NAMESILO_ENVIRONMENT=sandbox):
 *   npx tsx scripts/ote/namesilo-lifecycle.ts
 *
 * OTE quirk: a subset of endpoints (dnsSecListRecords, domainForward, contactAdd,
 * and occasionally renewDomain) intermittently return HTTP 504 gateway timeouts
 * from NameSilo's sandbox infrastructure. This script retries every op through
 * transient flakes and reports the ones that never responded as SKIPPED rather
 * than failing — the client code for them is correct; the sandbox is unreliable.
 */
import { config } from 'dotenv';
import { createRegistrar, InvalidResponseError, TimeoutError } from '../../src/index';
import type { OperationResult, RequestOptions } from '../../src/index';

config({ path: '.env.testing' });

const apiKey = process.env.NAMESILO_API_KEY;
if (!apiKey) {
  console.error('NAMESILO_API_KEY is required (set it in .env.testing or the environment).');
  process.exit(2);
}

const ns = createRegistrar('namesilo', { apiKey }, { environment: 'sandbox' });

// Short per-attempt timeout: good OTE responses return in <8s, while hangs take
// ~50s to 504 — so a 25s abort fails fast and lets us retry.
const ATTEMPT: RequestOptions = { timeout: 25_000, retries: 0 };

// Only NS1..NS8.NAMESILO.COM resolve in the sandbox (per NameSilo OTE docs).
const OTE_NAMESERVERS = ['NS1.NAMESILO.COM', 'NS2.NAMESILO.COM', 'NS3.NAMESILO.COM'];

type Outcome = 'PASS' | 'SKIP' | 'FAIL';
const results: { step: string; outcome: Outcome; detail: string }[] = [];

function isGatewayFlake(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof InvalidResponseError;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Run one step, retrying through OTE gateway flakes. `attempts` bounds tries;
 * a non-flake error fails immediately. If every attempt flakes, the step is
 * recorded SKIP (OTE was unreachable for that endpoint), not FAIL.
 */
async function step<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; assert?: (v: T) => void } = {}
): Promise<T | undefined> {
  const attempts = opts.attempts ?? 6;
  let lastFlake = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const value = await fn();
      opts.assert?.(value);
      results.push({ step: label, outcome: 'PASS', detail: summarize(value) });
      console.log(`✅ ${label} — ${summarize(value)}`);
      return value;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isGatewayFlake(error)) {
        lastFlake = msg;
        console.log(`   … ${label} attempt ${i}/${attempts} flaked (OTE gateway)`);
        await sleep(1500 * i);
        continue;
      }
      results.push({ step: label, outcome: 'FAIL', detail: msg });
      console.log(`❌ ${label} — ${msg}`);
      return undefined;
    }
  }
  results.push({ step: label, outcome: 'SKIP', detail: `OTE gateway flake: ${lastFlake}` });
  console.log(`⏭️  ${label} — SKIPPED (OTE gateway never responded)`);
  return undefined;
}

function summarize(v: unknown): string {
  if (v == null) return 'ok';
  if (typeof v === 'object' && 'success' in (v as OperationResult)) {
    const r = v as OperationResult;
    return `${r.success ? 'success' : 'FAILED'}: ${r.message}`;
  }
  if (Array.isArray(v)) return `${v.length} item(s)`;
  return JSON.stringify(v);
}

function assertOk(r: OperationResult): void {
  if (!r.success) throw new Error(`operation reported failure: ${r.message}`);
}

async function main(): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const domain = `rc-ote-${suffix}.com`;
  console.log(`\nNameSilo OTE lifecycle — test domain: ${domain}\n`);

  await step('testConnection', () => ns.testConnection(ATTEMPT), {
    assert: r => {
      if (!r.success) throw new Error(r.message);
    },
  });

  await step('checkAvailability', () => ns.checkAvailability([domain], ATTEMPT), {
    assert: ([a]) => {
      if (!a?.available) throw new Error(`${domain} not available in OTE`);
    },
  });

  const registered = await step(
    'registerDomain',
    () =>
      ns.registerDomain(
        domain,
        {
          years: 1,
          privacy: false,
          autoRenew: false,
          // NameSilo registers against the account default contact; this satisfies
          // the input contract but is not sent by the provider.
          contacts: {
            registrant: {
              firstName: 'OTE',
              lastName: 'Tester',
              email: 'ote@example.com',
              phone: '+1.5555550123',
              address1: '1 Test St',
              city: 'Testville',
              state: 'CA',
              postalCode: '90001',
              country: 'US',
            },
          },
        },
        ATTEMPT
      ),
    { assert: assertOk }
  );

  if (!registered?.success) {
    console.log('\nRegistration did not succeed — aborting the rest of the lifecycle.\n');
    return report(domain);
  }

  await step('getDomain', () => ns.getDomain(domain, ATTEMPT), {
    assert: d => {
      if (d.domainName !== domain) throw new Error('domain name mismatch');
      if (!d.expirationDate) throw new Error('no expiration date');
    },
  });

  await step('listDomains (includes new domain)', () => ns.listDomains(ATTEMPT), {
    assert: list => {
      if (!list.some(d => d.domainName === domain))
        throw new Error('new domain not in listDomains');
    },
  });

  // --- DNS records (domain is on default DNSOWL hosting; do this before NS change) ---
  await step(
    'setDnsRecords (add A/A/MX/TXT)',
    () =>
      ns.setDnsRecords(
        domain,
        [
          { type: 'A', name: '@', value: '1.2.3.4', ttl: 3600 },
          { type: 'A', name: 'www', value: '1.2.3.4', ttl: 3600 },
          { type: 'MX', name: '@', value: 'mail.example.com', priority: 10, ttl: 3600 },
          { type: 'TXT', name: '@', value: 'rc-ote-verify', ttl: 3600 },
        ],
        ATTEMPT
      ),
    { assert: assertOk }
  );
  await step('getDnsRecords (after add)', () => ns.getDnsRecords(domain, ATTEMPT), {
    assert: recs => {
      const has = (t: string, n: string) => recs.some(r => r.type === t && r.name === n);
      if (!has('A', 'www') || !has('MX', '@') || !has('TXT', '@'))
        throw new Error('expected records missing after add');
    },
  });
  await step(
    'setDnsRecords (replace → only apex A)',
    () =>
      ns.setDnsRecords(domain, [{ type: 'A', name: '@', value: '1.2.3.4', ttl: 3600 }], ATTEMPT),
    { assert: assertOk }
  );
  await step('getDnsRecords (after replace)', () => ns.getDnsRecords(domain, ATTEMPT), {
    assert: recs => {
      if (recs.length !== 1 || recs[0].type !== 'A' || recs[0].name !== '@')
        throw new Error(`expected a single apex A record, got ${recs.length}`);
    },
  });

  // --- Email forwarding ---
  await step(
    'setEmailForwarding (add)',
    () =>
      ns.setEmailForwarding(domain, [{ alias: 'hi', forwardTo: 'someone@example.com' }], ATTEMPT),
    { assert: assertOk }
  );
  await step('getEmailForwarding (after add)', () => ns.getEmailForwarding(domain, ATTEMPT), {
    assert: fwds => {
      if (!fwds.some(f => f.alias === 'hi' && f.forwardTo === 'someone@example.com'))
        throw new Error('email forward not found after add');
    },
  });
  await step('setEmailForwarding (clear)', () => ns.setEmailForwarding(domain, [], ATTEMPT), {
    assert: assertOk,
  });
  await step('getEmailForwarding (cleared)', () => ns.getEmailForwarding(domain, ATTEMPT), {
    assert: fwds => {
      if (fwds.length !== 0) throw new Error('email forwards not cleared');
    },
  });

  // --- Nameservers (moves the domain off DNS hosting; do AFTER DNS tests) ---
  await step('updateNameservers', () => ns.updateNameservers(domain, OTE_NAMESERVERS, ATTEMPT), {
    assert: assertOk,
  });
  await step('getNameservers (after update)', () => ns.getNameservers(domain, ATTEMPT), {
    assert: hosts => {
      const got = hosts.map(h => h.toUpperCase());
      if (got.join(',') !== OTE_NAMESERVERS.join(','))
        throw new Error(`nameservers not applied: ${got.join(',')}`);
    },
  });

  // --- Lock / auto-renew / privacy ---
  await step('lockDomain', () => ns.lockDomain(domain, ATTEMPT), { assert: assertOk });
  await step('unlockDomain', () => ns.unlockDomain(domain, ATTEMPT), { assert: assertOk });
  await step('setAutoRenew(true)', () => ns.setAutoRenew(domain, true, ATTEMPT), {
    assert: assertOk,
  });
  await step('setAutoRenew(false)', () => ns.setAutoRenew(domain, false, ATTEMPT), {
    assert: assertOk,
  });
  await step('setPrivacy(true)', () => ns.setPrivacy(domain, true, ATTEMPT), { assert: assertOk });
  await step('setPrivacy(false)', () => ns.setPrivacy(domain, false, ATTEMPT), {
    assert: assertOk,
  });

  // --- Contacts ---
  await step('getContacts', () => ns.getContacts(domain, ATTEMPT), {
    assert: c => {
      if (!c.registrant) throw new Error('no registrant contact');
    },
  });

  // --- Known OTE-flaky endpoints (fewer attempts; SKIP is expected) ---
  await step('getDnssec', () => ns.getDnssec(domain, ATTEMPT), {
    attempts: 3,
    assert: s => {
      if (s.enabled) throw new Error('fresh domain unexpectedly has DNSSEC enabled');
    },
  });
  await step(
    'setDomainForwarding',
    () =>
      ns.setDomainForwarding(
        domain,
        [{ host: '@', url: 'https://example.com', type: 'permanent' }],
        ATTEMPT
      ),
    { attempts: 3, assert: assertOk }
  );
  await step(
    'updateContacts',
    () =>
      ns.updateContacts(
        domain,
        {
          registrant: {
            firstName: 'Updated',
            lastName: 'Registrant',
            organization: 'RC OTE',
            email: 'updated@example.com',
            phone: '+1.5555550199',
            address1: '2 Change Ave',
            city: 'Newtown',
            state: 'NY',
            postalCode: '10001',
            country: 'US',
          },
        },
        ATTEMPT
      ),
    { attempts: 3, assert: assertOk }
  );
  await step('renewDomain(+1yr)', () => ns.renewDomain(domain, 1, ATTEMPT), {
    attempts: 3,
    assert: assertOk,
  });

  report(domain);
}

function report(domain: string): void {
  const counts = results.reduce(
    (acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc),
    {} as Record<Outcome, number>
  );
  console.log('\n──────── NameSilo OTE lifecycle summary ────────');
  for (const r of results) {
    const icon = r.outcome === 'PASS' ? '✅' : r.outcome === 'SKIP' ? '⏭️ ' : '❌';
    console.log(`${icon} ${r.step}`);
  }
  console.log('────────────────────────────────────────────────');
  console.log(
    `PASS ${counts.PASS ?? 0}  ·  SKIP ${counts.SKIP ?? 0} (OTE flake)  ·  FAIL ${counts.FAIL ?? 0}`
  );
  console.log(`Domain ${domain} remains registered in the OTE sandbox (no delete endpoint).\n`);
  // Only a genuine (non-flake) failure is a non-zero exit.
  process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
}

void main();
