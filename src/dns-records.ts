/**
 * Syntax and presentation for DNS resource records.
 *
 * No network, no zone origin, no provider. Names are not joined to a parent
 * and a suffix is never stripped: `www` and `www.example.com` are different
 * owners. Case is folded and one trailing dot is removed, because neither
 * changes which name you wrote (`WWW.Example.COM.` and `www.example.com` are
 * the same name). A trailing dot is not used to decide that a name is
 * relative to something else.
 *
 * Records are a flat list. Each entry is one owner, one type, one TTL, and
 * one data string. This module does not turn a list into an update plan.
 * Some providers want other types removed before a CNAME is written, and
 * some accept the whole set in one call. That sequence belongs to the
 * provider. `findCnameConflicts` only answers whether the set you already
 * have breaks the alias rule.
 *
 * Prepared names have no trailing dot. Add one yourself when an API asks for
 * an absolute name. `@` is left as `@`. It is not expanded to an origin,
 * and it is not treated as equal to any other owner.
 *
 * Label check is ASCII by default (letters, digits, hyphen, underscore).
 * Underscores stay, because real zones use them (`_dmarc`, DKIM, SRV).
 * Install `useLabelMapper` for Unicode. A strict hostname mapper (the IDNA
 * STD3 profile) will start rejecting those underscores; that is the mapper's
 * choice.
 *
 *   useLabelMapper((label) => idna.toAscii(label))  // null when the label is illegal
 *
 * Known data syntax: A, AAAA, CNAME, NS, MX, TXT, SRV, CAA, DS. Any other type is
 * trimmed and otherwise left alone, so a provider-specific type still round-trips.
 */

import type { DnsRecord } from './types';

export class DnsSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsSyntaxError';
  }
}

/** One resource record. `rdata` is a single value, not a list of values. */
export interface DnsEntry {
  owner: string;
  kind: string;
  ttl: number;
  rdata: string;
}

/** Something wrong with a set of records. `detail` is safe to show a person. */
export interface RecordClash {
  owner: string;
  kind: string;
  detail: string;
}

/**
 * `owner`  — a name that owns records. A leftmost `*` label is allowed.
 * `target` — a name used inside record data (CNAME, NS, MX). No wildcard.
 */
export type NameRole = 'owner' | 'target';

/**
 * Turn one label into the ASCII form to store.
 * Return null to reject the label. The default mapper does not punycode.
 */
export type LabelMapper = (label: string) => string | null;

export interface DelegationSigner {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

const NAME_LIMIT = 253;
const LABEL_LIMIT = 63;
const TTL_LIMIT = 2147483647;
const TEXT_OCTETS = 255;
// RDATA is at most 65535 octets, and each character-string costs one length
// octet: 257 strings of 255 octets plus their lengths.
const TEXT_TOTAL_OCTETS = 65535 - Math.ceil(65535 / (TEXT_OCTETS + 1));
const UINT16_MAX = 65535;

/** Digest type → hex length, for the sizes registered with IANA. Other type numbers are not rejected. */
const DIGEST_HEX_LENGTH: Record<number, number> = {
  1: 40,
  2: 64,
  3: 64,
  4: 96,
};

/**
 * Types that may sit at the same owner as a CNAME.
 * RFC 2181 says an alias owns the name. DNSSEC later allowed the signature
 * and denial records that describe that alias (RRSIG, NSEC, NSEC3).
 * Everything else — A, MX, TXT, NS, and so on — still conflicts.
 */
const KINDS_ALLOWED_BESIDE_CNAME = new Set(['CNAME', 'RRSIG', 'NSEC', 'NSEC3']);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function mapAsciiLabel(label: string): string | null {
  const folded = label.toLowerCase();
  if (folded.length < 1 || folded.length > LABEL_LIMIT) return null;
  // One character, or an inner hyphen run that does not start or end the label.
  // Underscore is included on purpose. See the file header.
  if (!/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(folded)) return null;
  return folded;
}

let labelMapper: LabelMapper = mapAsciiLabel;

export function useLabelMapper(mapper: LabelMapper): void {
  labelMapper = mapper;
}

export function resetLabelMapper(): void {
  labelMapper = mapAsciiLabel;
}

/**
 * Canonical owner or target.
 * Lowercase, one trailing dot removed, labels passed through the mapper.
 * Does not append, remove, or replace any other suffix.
 */
export function prepareName(input: string, role: NameRole = 'owner'): string {
  const trimmed = input.trim();
  if (!trimmed) throw new DnsSyntaxError('Name is empty');

  const bare = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!bare) throw new DnsSyntaxError('Name is empty');
  if (bare === '@') {
    if (role === 'target') throw new DnsSyntaxError('Origin token @ cannot be a record target');
    return '@';
  }

  const labels = bare.split('.');
  if (labels.some(label => label.length === 0)) {
    throw new DnsSyntaxError('Name contains an empty label');
  }

  const starLabels = labels.filter(label => label.includes('*'));
  if (starLabels.length > 0) {
    if (role !== 'owner') {
      throw new DnsSyntaxError('A wildcard is only valid as an owner name');
    }
    const starCount = starLabels.reduce(
      (count, label) => count + (label.match(/\*/g)?.length ?? 0),
      0
    );
    if (starCount > 1) throw new DnsSyntaxError('A name can contain only one wildcard');
    // RFC 4592: the wildcard is the entire leftmost label, not a prefix of one.
    if (labels[0] !== '*') throw new DnsSyntaxError('A wildcard must be its own leftmost label');
  }

  const mapped = labels.map(label => {
    if (label === '*') return '*';
    const ascii = labelMapper(label);
    if (!ascii) throw new DnsSyntaxError(`Label is not a valid DNS label: ${label}`);
    return ascii.toLowerCase();
  });

  const name = mapped.join('.');
  if (name.length > NAME_LIMIT) throw new DnsSyntaxError('Name is longer than 253 characters');
  return name;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Dotted IPv4. Leading zeros are rejected (`01.2.3.4` is not `1.2.3.4`). */
export function isIpv4(text: string): boolean {
  const octets = text.split('.');
  if (octets.length !== 4) return false;
  return octets.every(octet => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255 && String(value) === octet;
  });
}

/**
 * IPv6 text form: eight groups, a single `::`, or an IPv4 tail
 * (`::ffff:192.0.2.1`). No zone index (`fe80::1%eth0`).
 */
export function isIpv6(text: string): boolean {
  let body = text;

  const embedded = text.match(/^(.+):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) {
    if (!isIpv4(embedded[2])) return false;
    body = `${embedded[1]}:0:0`;
  }

  const compressedAt = body.indexOf('::');
  if (compressedAt !== -1) {
    if (body.indexOf('::', compressedAt + 1) !== -1) return false;
    const head = body.slice(0, compressedAt).split(':').filter(Boolean);
    const tail = body
      .slice(compressedAt + 2)
      .split(':')
      .filter(Boolean);
    // `::` replaces at least one group, so at most 7 groups are written out.
    if (head.length + tail.length > 7) return false;
    return [...head, ...tail].every(group => /^[0-9a-fA-F]{1,4}$/.test(group));
  }

  const groups = body.split(':');
  return groups.length === 8 && groups.every(group => /^[0-9a-fA-F]{1,4}$/.test(group));
}

// ---------------------------------------------------------------------------
// Record data
// ---------------------------------------------------------------------------

function utf8OctetCount(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) count += 1;
    else if (code <= 0x7ff) count += 2;
    else if (code <= 0xffff) count += 3;
    else count += 4;
  }
  return count;
}

function decimalInRange(token: string, limit: number): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
  const value = Number(token);
  if (value > limit) return null;
  return value;
}

function prepareIpv4(text: string): string {
  if (!isIpv4(text)) throw new DnsSyntaxError('IPv4 address is invalid');
  return text;
}

function prepareIpv6(text: string): string {
  if (!isIpv6(text)) throw new DnsSyntaxError('IPv6 address is invalid');
  return text.toLowerCase();
}

/**
 * CNAME or NS target.
 * An address is rejected for both: a CNAME is an alias to a name, and an NS
 * target is a host name. Numeric labels would otherwise look like a legal name.
 * Self-alias is checked only for CNAME, and only against the owner string as
 * written. `www` aliasing to `www.example.com` is not treated as a loop.
 */
function prepareHostTarget(text: string, owner: string | undefined, rejectSelf: boolean): string {
  const withoutDot = text.endsWith('.') ? text.slice(0, -1) : text;
  if (isIpv4(withoutDot) || isIpv6(withoutDot)) {
    throw new DnsSyntaxError('Target must be a domain name, not an address');
  }
  const target = prepareName(text, 'target');
  if (rejectSelf && owner !== undefined && prepareName(owner, 'owner') === target) {
    throw new DnsSyntaxError('CNAME target is the same name as its owner');
  }
  return target;
}

/** `priority host`. Priority is a 16-bit unsigned integer. The host is a target name. */
function prepareMailExchange(text: string): string {
  const parts = text.split(/\s+/);
  if (parts.length !== 2) {
    throw new DnsSyntaxError('MX data must be "<priority> <mail host>"');
  }
  const priority = decimalInRange(parts[0], UINT16_MAX);
  if (priority === null) throw new DnsSyntaxError('MX priority must be an integer from 0 to 65535');
  return `${priority} ${prepareServiceHost(parts[1])}`;
}

/**
 * MX or SRV host. A lone `.` is the root: "no service here" (null MX, RFC 7505;
 * SRV, RFC 2782). It stays `.` because there is no name left to prepare.
 */
function prepareServiceHost(text: string): string {
  return text === '.' ? '.' : prepareName(text, 'target');
}

/** `priority weight port target`, each number a 16-bit unsigned integer. */
function prepareService(text: string): string {
  const parts = text.split(/\s+/);
  if (parts.length !== 4) {
    throw new DnsSyntaxError('SRV data must be "<priority> <weight> <port> <target>"');
  }
  const [priority, weight, port] = parts.slice(0, 3).map(part => decimalInRange(part, UINT16_MAX));
  if (priority === null)
    throw new DnsSyntaxError('SRV priority must be an integer from 0 to 65535');
  if (weight === null) throw new DnsSyntaxError('SRV weight must be an integer from 0 to 65535');
  if (port === null) throw new DnsSyntaxError('SRV port must be an integer from 0 to 65535');
  return `${priority} ${weight} ${port} ${prepareServiceHost(parts[3])}`;
}

/**
 * `flags tag value` (RFC 8659). Flags fit in one octet; the tag is 1–15
 * letters or digits, folded to lowercase. The value may be quoted or bare and
 * comes back quoted.
 */
function prepareAuthorization(text: string): string {
  const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (!match) throw new DnsSyntaxError('CAA data must be "<flags> <tag> <value>"');
  const flags = decimalInRange(match[1], 255);
  if (flags === null) throw new DnsSyntaxError('CAA flags must be an integer from 0 to 255');
  if (!/^[a-z0-9]{1,15}$/i.test(match[2])) {
    throw new DnsSyntaxError('CAA tag must be 1 to 15 letters or digits');
  }
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(match[3]);
  const value = quoted ? quoted[1] : match[3];
  if (!quoted && value.includes('"')) {
    throw new DnsSyntaxError('CAA value must be one quoted or unquoted string');
  }
  return `${flags} ${match[2].toLowerCase()} "${value}"`;
}

/**
 * TXT data, as one string of text.
 * On the wire a TXT record is a run of character-strings of at most 255
 * octets each. Text longer than that (a DKIM key, a long SPF policy) is split
 * into several strings when written, so the limit here is the whole record:
 * 65535 octets of RDATA, less a length octet per string. This function does
 * not add or remove quotes; quotes in the input stay part of the text.
 */
function prepareText(text: string): string {
  if (utf8OctetCount(text) > TEXT_TOTAL_OCTETS) {
    throw new DnsSyntaxError(`TXT data is longer than ${TEXT_TOTAL_OCTETS} octets`);
  }
  return text;
}

function readSignerFields(text: string): DelegationSigner {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 4)
    throw new DnsSyntaxError('DS data must be "<key tag> <algorithm> <digest type> <digest>"');

  const keyTag = decimalInRange(parts[0], UINT16_MAX);
  const algorithm = decimalInRange(parts[1], 255);
  const digestType = decimalInRange(parts[2], 255);
  if (keyTag === null || algorithm === null || digestType === null || !parts[3]) {
    throw new DnsSyntaxError('DS data must be "<key tag> <algorithm> <digest type> <digest>"');
  }

  const digest = parts[3].toLowerCase();
  if (!/^[0-9a-f]+$/.test(digest)) throw new DnsSyntaxError('DS digest must be hexadecimal');

  const expectedLength = DIGEST_HEX_LENGTH[digestType];
  if (expectedLength !== undefined && digest.length !== expectedLength) {
    throw new DnsSyntaxError(
      `DS digest must be ${expectedLength} hex characters for digest type ${digestType}`
    );
  }

  return { keyTag, algorithm, digestType, digest };
}

export function readDelegationSigner(rdata: string): DelegationSigner {
  return readSignerFields(rdata);
}

function prepareSignerText(text: string): string {
  const signer = readSignerFields(text);
  return `${signer.keyTag} ${signer.algorithm} ${signer.digestType} ${signer.digest}`;
}

/**
 * Canonical data for one record.
 * Pass `owner` when checking a CNAME so a target equal to that owner is rejected.
 * Unknown types are trimmed only.
 */
export function prepareRdata(kind: string, rdata: string, owner?: string): string {
  const token = kind.trim().toUpperCase();
  const text = rdata.trim();
  if (!text) throw new DnsSyntaxError('Record data is empty');

  switch (token) {
    case 'A':
      return prepareIpv4(text);
    case 'AAAA':
      return prepareIpv6(text);
    case 'CNAME':
      return prepareHostTarget(text, owner, true);
    case 'NS':
      return prepareHostTarget(text, undefined, false);
    case 'MX':
      return prepareMailExchange(text);
    case 'TXT':
      return prepareText(text);
    case 'SRV':
      return prepareService(text);
    case 'CAA':
      return prepareAuthorization(text);
    case 'DS':
      return prepareSignerText(text);
    default:
      return text;
  }
}

/** Canonical entry. TTL is the DNS unsigned range used on the wire in practice: 0 through 2^31−1. */
export function prepareEntry(entry: DnsEntry): DnsEntry {
  if (!Number.isInteger(entry.ttl) || entry.ttl < 0 || entry.ttl > TTL_LIMIT) {
    throw new DnsSyntaxError('TTL must be an integer from 0 to 2147483647');
  }
  const kind = entry.kind.trim().toUpperCase();
  if (!kind) throw new DnsSyntaxError('Record type is empty');
  return {
    owner: prepareName(entry.owner, 'owner'),
    kind,
    ttl: entry.ttl,
    rdata: prepareRdata(kind, entry.rdata, entry.owner),
  };
}

// ---------------------------------------------------------------------------
// Sets of records
// ---------------------------------------------------------------------------

function syntaxClash(entry: DnsEntry, error: unknown): RecordClash {
  const detail = error instanceof Error ? error.message : 'Invalid record';
  return { owner: entry.owner, kind: entry.kind, detail };
}

/**
 * Alias rule for a set of records that will exist at the same time.
 *
 * Owners match only after `prepareName` (case and a trailing dot).
 * `www` does not match `www.example.com`.
 *
 * Reports one clash when a name has more than one CNAME, and one clash when
 * a CNAME shares a name with a type other than RRSIG, NSEC, or NSEC3.
 * Does not say which write to send first.
 */
export function findCnameConflicts(entries: readonly DnsEntry[]): RecordClash[] {
  const clashes: RecordClash[] = [];
  const byOwner = new Map<string, DnsEntry[]>();

  for (const entry of entries) {
    let owner: string;
    let kind: string;
    try {
      owner = prepareName(entry.owner, 'owner');
      kind = entry.kind.trim().toUpperCase();
      if (!kind) throw new DnsSyntaxError('Record type is empty');
    } catch (error) {
      clashes.push(syntaxClash(entry, error));
      continue;
    }
    const group = byOwner.get(owner) ?? [];
    group.push({ ...entry, owner, kind });
    byOwner.set(owner, group);
  }

  for (const [owner, group] of byOwner) {
    const aliasCount = group.filter(entry => entry.kind === 'CNAME').length;
    if (aliasCount === 0) continue;

    if (aliasCount > 1) {
      clashes.push({
        owner,
        kind: 'CNAME',
        detail: 'A name can have only one CNAME target',
      });
    }

    const others = [...new Set(group.map(entry => entry.kind))].filter(
      kind => !KINDS_ALLOWED_BESIDE_CNAME.has(kind)
    );
    if (others.length > 0) {
      clashes.push({
        owner,
        kind: 'CNAME',
        detail: `A CNAME cannot share a name with ${others.join(', ')}`,
      });
    }
  }

  return clashes;
}

/**
 * Same owner, same type, same prepared data, more than once.
 * CNAME is omitted here; more than one alias at a name is reported by `findCnameConflicts`.
 * Entries that fail `prepareEntry` are returned as clashes instead of throwing.
 */
export function findRepeatedRecords(entries: readonly DnsEntry[]): RecordClash[] {
  const clashes: RecordClash[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    let prepared: DnsEntry;
    try {
      prepared = prepareEntry(entry);
    } catch (error) {
      clashes.push(syntaxClash(entry, error));
      continue;
    }
    if (prepared.kind === 'CNAME') continue;

    const key = `${prepared.owner}\0${prepared.kind}\0${prepared.rdata}`;
    if (seen.has(key)) {
      clashes.push({
        owner: prepared.owner,
        kind: prepared.kind,
        detail: `Repeated ${prepared.kind} data at this name`,
      });
    }
    seen.add(key);
  }

  return clashes;
}

// ---------------------------------------------------------------------------
// registrar-client records
// ---------------------------------------------------------------------------

/**
 * A registrar-client `DnsRecord` as an entry for the functions above. MX and
 * SRV carry their numbers as separate fields there, so they're folded into the
 * data string here. `name` stays relative to the zone (`@`, `www`), as above.
 */
export function toDnsEntry(record: DnsRecord, defaultTtl = 3600): DnsEntry {
  const kind = record.type.trim().toUpperCase();
  const numbers =
    kind === 'MX'
      ? [record.priority]
      : kind === 'SRV'
        ? [record.priority, record.weight, record.port]
        : [];
  return {
    owner: record.name,
    kind,
    ttl: record.ttl ?? defaultTtl,
    rdata: [...numbers.map(n => (n === undefined ? '' : String(n))), record.value.trim()].join(' '),
  };
}
