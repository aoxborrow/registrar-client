import { XMLParser, type X2jOptions } from 'fast-xml-parser';
import { ParsingError } from './errors.js';

// Shared XML parsing for registrar APIs that speak XML (e.g. Namecheap, Enom).
// fast-xml-parser is pure JS with no Node built-ins, so this stays safe in
// browsers, Cloudflare Workers, Deno, Bun, and Node.

// default options applied to all registrar XML responses:
// - attributes are kept (prefixed with `@_`)
// - values are left as raw strings; providers coerce them explicitly, so a
//   ZIP like "01234" or a flag like "true" never changes type unexpectedly
const DEFAULT_XML_OPTIONS: Partial<X2jOptions> = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
};

// parse an XML string into a plain object, throwing ParsingError on failure
export function parseXml<T = unknown>(xml: string, options?: Partial<X2jOptions>): T {
  try {
    const parser = new XMLParser({ ...DEFAULT_XML_OPTIONS, ...options });
    return parser.parse(xml) as T;
  } catch (error) {
    throw new ParsingError(
      `Failed to parse XML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// coerce a value that may be a single item or an array into an array.
// XML parsers collapse a single repeated element into one object; this
// normalizes both cases to an array.
export function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
