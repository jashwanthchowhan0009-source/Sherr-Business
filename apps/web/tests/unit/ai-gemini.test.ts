import { describe, expect, it, vi } from 'vitest';
import { geminiProvider } from '@/lib/ai/gemini';
import { EXTRACTION_PROMPT, PROMPT_VERSION } from '@/lib/ai/prompt';

const BYTES = Buffer.from('%PDF-1.4 fake invoice bytes');

/** A reply in the shape Gemini actually returns. */
function reply(text: string, extra: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 },
    ...extra,
  };
}

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

const GOOD_JSON = JSON.stringify({
  kind: 'purchase_invoice',
  supplierName: { value: 'Acme Traders', confidence: 0.97 },
  invoiceNumber: { value: 'AT/0042', confidence: 0.95 },
  lines: [{ description: 'Rice', taxableAmount: '100000', gstRatePercent: '5' }],
  statedGrandTotal: { value: '105000', confidence: 0.96 },
});

describe('geminiProvider', () => {
  it('reports who answered, for the audit row', () => {
    const provider = geminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    expect(provider.name).toBe('google-gemini');
    expect(provider.model).toBe('gemini-2.5-flash');
    expect(provider.promptVersion).toBe(PROMPT_VERSION);
  });

  it('sends the prompt, the bytes and the key in a header', async () => {
    const fetchImpl = fetchReturning(reply(GOOD_JSON));
    const provider = geminiProvider({ apiKey: 'secret-key', fetchImpl });

    await provider.extract({ bytes: BYTES, mimeType: 'application/pdf' });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('gemini-2.5-flash:generateContent');

    // The key never belongs in a URL, where it reaches logs and proxy records.
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');

    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[0].text).toBe(EXTRACTION_PROMPT);
    expect(body.contents[0].parts.at(-1).inlineData).toEqual({
      mimeType: 'application/pdf',
      data: BYTES.toString('base64'),
    });
  });

  it('asks for JSON and zero temperature, so the answer is constrained not merely requested', async () => {
    const fetchImpl = fetchReturning(reply(GOOD_JSON));
    await geminiProvider({ apiKey: 'k', fetchImpl }).extract({
      bytes: BYTES,
      mimeType: 'image/png',
    });

    const body = JSON.parse(String((vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.temperature).toBe(0);
  });

  it('passes the uploader’s guess as a hint the model may reject', async () => {
    const fetchImpl = fetchReturning(reply(GOOD_JSON));
    await geminiProvider({ apiKey: 'k', fetchImpl }).extract({
      bytes: BYTES,
      mimeType: 'image/png',
      declaredType: 'purchase bill',
    });

    const body = JSON.parse(String((vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit])[1].body));
    expect(JSON.stringify(body.contents[0].parts)).toContain('You may disagree');
  });

  it('parses a good reply into a document', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(reply(GOOD_JSON)),
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.supplierName.value).toBe('Acme Traders');
    expect(result.document.lines).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
  });

  it('parses a reply the model fenced despite being told not to', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(reply('```json\n' + GOOD_JSON + '\n```')),
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });
    expect(result.ok).toBe(true);
  });

  it('names the setting to fix when the key is refused', async () => {
    for (const status of [401, 403]) {
      const result = await geminiProvider({
        apiKey: 'k',
        fetchImpl: fetchReturning('forbidden', status),
      }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('GEMINI_API_KEY');
    }
  });

  it('says to wait when the free tier’s limit is hit, rather than reporting an error code', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning('rate limited', 429),
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/rate limit/i);
    expect(result.reason).toMatch(/Wait a minute/);
  });

  it('says nothing was changed when the model is down', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning('bad gateway', 502),
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Nothing was changed/);
  });

  it('fails rather than inventing a document when the reply is not JSON', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(reply('I am unable to read this image.')),
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/did not return JSON/);
    // The raw reply is kept, so a person can see what was actually said.
    expect(JSON.stringify(result.raw)).toContain('unable to read');
  });

  it('explains a safety block rather than reporting an empty answer', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning({ promptFeedback: { blockReason: 'SAFETY' } }),
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/declined to read this document \(SAFETY\)/);
  });

  it('explains a truncated reply, which on an invoice means too many lines', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning({
        candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
      }),
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/too many lines/);
  });

  it('reports a network failure without throwing', async () => {
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Could not reach the model: ECONNREFUSED/);
  });

  it('reports a timeout as a timeout', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const result = await geminiProvider({
      apiKey: 'k',
      fetchImpl: vi.fn(async () => {
        throw abortError;
      }) as unknown as typeof fetch,
    }).extract({ bytes: BYTES, mimeType: 'application/pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/did not answer within 60s/);
  });
});

describe('the prompt', () => {
  // The prompt is wrapped for reading, so assertions run against it with
  // whitespace collapsed — otherwise a reflow would break a test that is about
  // the instruction, not its line breaks.
  const prompt = EXTRACTION_PROMPT.replace(/\s+/g, ' ');

  it('tells the model not to compute, which is the rule the product depends on', () => {
    expect(prompt).toMatch(/do NOT recompute tax/);
    expect(prompt).toMatch(/Transcribe, do not compute/);
    expect(prompt).toMatch(/do NOT correct a total that looks wrong/);
  });

  it('tells the model a null is better than a guess', () => {
    expect(prompt).toMatch(/Never guess/);
    expect(prompt).toMatch(/plausible-looking wrong value/);
  });

  it('asks for every amount as a string', () => {
    expect(prompt).toMatch(/as a string/);
  });

  it('tells the model to say `other` rather than guess the direction', () => {
    // Guessing wrong puts a purchase in the sales register.
    expect(prompt).toMatch(/cannot tell which direction it points, use "other"/);
  });

  it('is versioned, so a stored extraction stays interpretable', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});
