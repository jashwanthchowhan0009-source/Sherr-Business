import 'server-only';
import { providerFromEnv } from './gemini';
import type { ExtractionProvider } from './contract';

/**
 * Which provider reads a document.
 *
 * A plain module rather than part of the server-action file, and deliberately so.
 * An override exported from a `'use server'` module is itself a server action: the
 * browser could call it and point the extraction at somewhere else, which would
 * mean anyone who can reach the app choosing where these documents are sent. Tests
 * replace this module instead, which no request can do.
 */
export function currentProvider(): ExtractionProvider {
  return providerFromEnv();
}
