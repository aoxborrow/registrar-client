import { afterEach, describe, expect, it } from 'vitest';
import {
  DnsSyntaxError,
  findCnameConflicts,
  findRepeatedRecords,
  isIpv4,
  isIpv6,
  prepareEntry,
  prepareName,
  prepareRdata,
  readDelegationSigner,
  resetLabelMapper,
  toDnsEntry,
  useLabelMapper,
  type DnsEntry,
} from '../src/dns';

const entry = (owner: string, kind: string, rdata: string, ttl = 300): DnsEntry => ({
  owner,
  kind,
  ttl,
  rdata,
});

afterEach(() => resetLabelMapper());

describe('prepareName', () => {
  it('folds case and one trailing dot, and never joins or strips a zone', () => {
    expect(prepareName('WWW.Example.COM.')).toBe('www.example.com');
    expect(prepareName(' www ')).toBe('www');
    expect(prepareName('@')).toBe('@');
    expect(prepareName('_dmarc.example.com')).toBe('_dmarc.example.com');
  });
  it('allows one wildcard, only as the whole leftmost label of an owner', () => {
    expect(prepareName('*.example.com')).toBe('*.example.com');
    expect(() => prepareName('a*.example.com')).toThrow(/leftmost label/);
    expect(() => prepareName('*.*.example.com')).toThrow(/only one wildcard/);
    expect(() => prepareName('*.example.com', 'target')).toThrow(/only valid as an owner/);
  });
  it.each([
    ['', /empty/],
    ['.', /empty/],
    ['a..b', /empty label/],
    ['-a.com', /not a valid DNS label/],
    [`${'a'.repeat(64)}.com`, /not a valid DNS label/],
    [`${'a.'.repeat(127)}com`, /253/],
  ])('rejects %j', (name, message) => {
    expect(() => prepareName(name)).toThrow(DnsSyntaxError);
    expect(() => prepareName(name)).toThrow(message);
  });
  it('rejects @ as a target', () => {
    expect(() => prepareName('@', 'target')).toThrow(/cannot be a record target/);
  });
  it('maps labels through an installed mapper', () => {
    useLabelMapper(label =>
      label.toLowerCase() === 'bücher' ? 'xn--bcher-kva' : label.toLowerCase()
    );
    expect(prepareName('Bücher.example')).toBe('xn--bcher-kva.example');
    useLabelMapper(() => null);
    expect(() => prepareName('a.example')).toThrow(/not a valid DNS label/);
  });
});

describe('addresses', () => {
  it('checks IPv4 strictly', () => {
    expect(isIpv4('192.0.2.1')).toBe(true);
    for (const bad of ['01.2.3.4', '256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d']) {
      expect(isIpv4(bad)).toBe(false);
    }
  });
  it('checks IPv6, with one :: and an optional IPv4 tail', () => {
    for (const good of ['2001:db8::1', '::', '::1', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1']) {
      expect(isIpv6(good)).toBe(true);
    }
    for (const bad of [
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      'fe80::1%eth0',
      '::ffff:999.0.2.1',
      'g::1',
    ]) {
      expect(isIpv6(bad)).toBe(false);
    }
  });
});

describe('prepareRdata', () => {
  it('A and AAAA', () => {
    expect(prepareRdata('a', ' 192.0.2.1 ')).toBe('192.0.2.1');
    expect(prepareRdata('AAAA', '2001:DB8::1')).toBe('2001:db8::1');
    expect(() => prepareRdata('A', '2001:db8::1')).toThrow(/IPv4/);
    expect(() => prepareRdata('AAAA', '192.0.2.1')).toThrow(/IPv6/);
  });
  it('CNAME and NS take a host name, not an address or the owner itself', () => {
    expect(prepareRdata('CNAME', 'Example.NET.')).toBe('example.net');
    expect(prepareRdata('NS', 'ns1.example.net')).toBe('ns1.example.net');
    expect(() => prepareRdata('CNAME', '192.0.2.1')).toThrow(/not an address/);
    expect(() => prepareRdata('NS', '2001:db8::1')).toThrow(/not an address/);
    expect(() => prepareRdata('CNAME', 'www', 'WWW')).toThrow(/same name as its owner/);
    // only the owner as written: a relative owner isn't joined to a zone
    expect(prepareRdata('CNAME', 'www.example.com', 'www')).toBe('www.example.com');
  });
  it('MX, including the null MX', () => {
    expect(prepareRdata('MX', '10  Mail.Example.NET.')).toBe('10 mail.example.net');
    expect(prepareRdata('MX', '0 .')).toBe('0 .');
    expect(() => prepareRdata('MX', 'mail.example.net')).toThrow(/<priority> <mail host>/);
    expect(() => prepareRdata('MX', '70000 mail.example.net')).toThrow(/0 to 65535/);
    expect(() => prepareRdata('MX', '010 mail.example.net')).toThrow(/0 to 65535/);
    expect(() => prepareRdata('MX', '10 192.0.2.1')).toThrow(/not an address/);
  });
  it('SRV, including the root target for "no service"', () => {
    expect(prepareRdata('SRV', '10 5 5060 SIP.example.com.')).toBe('10 5 5060 sip.example.com');
    expect(prepareRdata('SRV', '0 0 0 .')).toBe('0 0 0 .');
    expect(() => prepareRdata('SRV', '10 5 sip.example.com')).toThrow(/<priority> <weight>/);
    expect(() => prepareRdata('SRV', '10 5 70000 sip.example.com')).toThrow(/port/);
    expect(() => prepareRdata('SRV', '10 x 1 sip.example.com')).toThrow(/weight/);
    expect(() => prepareRdata('SRV', '10 5 5060 192.0.2.1.')).toThrow(/not an address/);
  });
  it('CAA, quoted or bare, comes back quoted with a lowercase tag', () => {
    expect(prepareRdata('CAA', '0 issue "letsencrypt.org"')).toBe('0 issue "letsencrypt.org"');
    expect(prepareRdata('CAA', '128 ISSUEWILD letsencrypt.org')).toBe(
      '128 issuewild "letsencrypt.org"'
    );
    expect(prepareRdata('CAA', '0 iodef "mailto:security@example.com"')).toBe(
      '0 iodef "mailto:security@example.com"'
    );
    expect(() => prepareRdata('CAA', '256 issue "x"')).toThrow(/flags/);
    expect(() => prepareRdata('CAA', '0 is-sue "x"')).toThrow(/tag/);
    expect(() => prepareRdata('CAA', '0 issue')).toThrow(/<flags> <tag> <value>/);
    expect(() => prepareRdata('CAA', '0 issue a"b')).toThrow(/one quoted or unquoted string/);
  });
  it('TXT accepts text longer than one 255-octet string, up to a whole record', () => {
    const dkim = `v=DKIM1; k=rsa; p=${'A'.repeat(400)}`;
    expect(prepareRdata('TXT', dkim)).toBe(dkim);
    expect(prepareRdata('TXT', '"quoted" stays')).toBe('"quoted" stays');
    expect(() => prepareRdata('TXT', 'a'.repeat(70000))).toThrow(/TXT data is longer/);
  });
  it('DS checks fields and the digest length for known digest types', () => {
    const digest = 'AB'.repeat(32);
    expect(prepareRdata('DS', `60485 8 2 ${digest}`)).toBe(`60485 8 2 ${digest.toLowerCase()}`);
    expect(readDelegationSigner(`60485 8 2 ${digest}`)).toEqual({
      keyTag: 60485,
      algorithm: 8,
      digestType: 2,
      digest: digest.toLowerCase(),
    });
    expect(() => prepareRdata('DS', '60485 8 2 abcd')).toThrow(/64 hex characters/);
    expect(() => prepareRdata('DS', '60485 8 2 xyz')).toThrow(/hexadecimal/);
    // an unregistered digest type isn't held to a length
    expect(prepareRdata('DS', '1 8 9 abcd')).toBe('1 8 9 abcd');
  });
  it('passes any other type through trimmed, and rejects empty data', () => {
    expect(prepareRdata('TLSA', ' 3 1 1 abcdef ')).toBe('3 1 1 abcdef');
    expect(prepareRdata('HTTPS', '1 . alpn=h2')).toBe('1 . alpn=h2');
    expect(() => prepareRdata('A', '  ')).toThrow(/empty/);
  });
});

describe('prepareEntry', () => {
  it('prepares every field', () => {
    expect(prepareEntry(entry('WWW', 'cname', 'Example.NET.', 3600))).toEqual({
      owner: 'www',
      kind: 'CNAME',
      ttl: 3600,
      rdata: 'example.net',
    });
  });
  it.each([-1, 1.5, 2147483648])('rejects a TTL of %d', ttl => {
    expect(() => prepareEntry(entry('@', 'A', '192.0.2.1', ttl))).toThrow(/TTL/);
  });
  it('rejects an empty type', () => {
    expect(() => prepareEntry(entry('@', ' ', '192.0.2.1'))).toThrow(/type is empty/);
  });
});

describe('record sets', () => {
  it('finds CNAMEs that share a name, after folding case and the trailing dot', () => {
    expect(
      findCnameConflicts([
        entry('www', 'CNAME', 'a.example.net'),
        entry('WWW.', 'CNAME', 'b.example.net'),
        entry('www', 'A', '192.0.2.1'),
        entry('www', 'RRSIG', 'x'),
        entry('mail', 'CNAME', 'c.example.net'),
        entry('mail.example.com', 'A', '192.0.2.1'),
      ])
    ).toEqual([
      { owner: 'www', kind: 'CNAME', detail: 'A name can have only one CNAME target' },
      { owner: 'www', kind: 'CNAME', detail: 'A CNAME cannot share a name with A' },
    ]);
  });
  it('finds repeated records, ignoring case and spacing', () => {
    expect(
      findRepeatedRecords([
        entry('@', 'MX', '10 mail.example.net'),
        entry('@', 'mx', '10  MAIL.example.net.'),
        entry('@', 'MX', '20 mail.example.net'),
      ])
    ).toEqual([{ owner: '@', kind: 'MX', detail: 'Repeated MX data at this name' }]);
  });
  it('reports entries that fail syntax as clashes instead of throwing', () => {
    expect(findRepeatedRecords([entry('@', 'A', 'nope')])).toEqual([
      { owner: '@', kind: 'A', detail: 'IPv4 address is invalid' },
    ]);
  });
});

describe('toDnsEntry', () => {
  it('folds MX and SRV numbers into the data and keeps the name relative', () => {
    expect(
      toDnsEntry({ type: 'mx', name: '@', value: 'mail.example.net', priority: 10, ttl: 600 })
    ).toEqual({ owner: '@', kind: 'MX', ttl: 600, rdata: '10 mail.example.net' });
    expect(
      prepareEntry(
        toDnsEntry({
          type: 'SRV',
          name: '_sip._tcp',
          value: 'sip.example.com.',
          priority: 10,
          weight: 5,
          port: 5060,
        })
      )
    ).toEqual({ owner: '_sip._tcp', kind: 'SRV', ttl: 3600, rdata: '10 5 5060 sip.example.com' });
  });
  it('passes CAA and TXT values through, and flags a missing MX priority', () => {
    expect(toDnsEntry({ type: 'CAA', name: '@', value: '0 issue "ca.example"' }, 300).rdata).toBe(
      '0 issue "ca.example"'
    );
    expect(() =>
      prepareEntry(toDnsEntry({ type: 'MX', name: '@', value: 'mail.example.net' }))
    ).toThrow(/<priority> <mail host>/);
  });
});
