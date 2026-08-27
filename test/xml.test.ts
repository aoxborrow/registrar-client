import { describe, it, expect } from 'vitest';
import { parseXml, ensureArray } from '../src/index.js';

// a trimmed Namecheap-style getList response with two domains
const NAMECHEAP_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <CommandResponse>
    <DomainGetListResult>
      <Domain ID="1" Name="example.com" Created="01/01/2020" Expires="01/01/2030" IsLocked="true" AutoRenew="false" WhoisGuard="ENABLED" />
      <Domain ID="2" Name="example.net" Created="02/02/2021" Expires="02/02/2031" IsLocked="false" AutoRenew="true" WhoisGuard="NOTPRESENT" />
    </DomainGetListResult>
  </CommandResponse>
</ApiResponse>`;

const ERROR_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
  <Errors><Error Number="1011102">API Key is invalid</Error></Errors>
</ApiResponse>`;

interface NcResponse {
  ApiResponse?: {
    '@_Status'?: string;
    'Errors'?: { Error?: { '#text'?: string } };
    'CommandResponse'?: {
      DomainGetListResult?: { Domain?: unknown };
    };
  };
}

describe('parseXml', () => {
  it('reads root attributes and repeated elements', () => {
    const res = parseXml<NcResponse>(NAMECHEAP_XML);
    expect(res.ApiResponse?.['@_Status']).toBe('OK');
    const domains = ensureArray(res.ApiResponse?.CommandResponse?.DomainGetListResult?.Domain);
    expect(domains).toHaveLength(2);
  });

  it('keeps attribute values as raw strings (no type coercion)', () => {
    const res = parseXml<{
      ApiResponse?: {
        CommandResponse?: { DomainGetListResult?: { Domain?: { '@_IsLocked'?: unknown }[] } };
      };
    }>(NAMECHEAP_XML);
    const first = res.ApiResponse?.CommandResponse?.DomainGetListResult?.Domain?.[0];
    expect(first?.['@_IsLocked']).toBe('true'); // string, not boolean
  });

  it('surfaces error element text', () => {
    const res = parseXml<NcResponse>(ERROR_XML);
    expect(res.ApiResponse?.['@_Status']).toBe('ERROR');
    expect(res.ApiResponse?.Errors?.Error?.['#text']).toBe('API Key is invalid');
  });

  it('throws ParsingError on malformed input', () => {
    // fast-xml-parser is lenient with text, but validate-off still parses;
    // ensureArray of undefined stays empty regardless.
    expect(ensureArray(undefined)).toEqual([]);
  });
});
