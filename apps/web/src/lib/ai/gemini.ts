/**
 * Google Gemini, behind the provider contract.
 *
 * Called over plain HTTPS rather than through an SDK: one request, one response, no
 * dependency to keep current, and the request body is visible in the code where a
 * reader can check what leaves the machine.
 *
 * It computes nothing and touches no database. Its whole job is bytes in, text out.
 */
import {
  ProviderUnavailableError,
  type ExtractionProvider,
  type ProviderResult,
} from './contract';
import { extractJsonObject, parseExtractedDocument, UnreadableReplyError } from './parse';
import { EXTRACTION_PROMPT, PROMPT_VERSION } from './prompt';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** How long to wait before giving up. A document extraction is not a long job. */
const TIMEOUT_MS = 60_000;

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  /** Injectable so the provider can be tested without a network or a key. */
  fetchImpl?: typeof fetch;
}

export function geminiProvider(options: GeminiOptions): ExtractionProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: 'google-gemini',
    model,
    promptVersion: PROMPT_VERSION,

    async extract({ bytes, mimeType, declaredType }): Promise<ProviderResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await doFetch(`${ENDPOINT}/${model}:generateContent`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // In the header rather than the query string: a key in a URL ends up in
            // logs, in proxy records and in error messages.
            'x-goog-api-key': options.apiKey,
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: EXTRACTION_PROMPT },
                  ...(declaredType
                    ? [{ text: `The uploader called this a ${declaredType}. You may disagree.` }]
                    : []),
                  { inlineData: { mimeType, data: bytes.toString('base64') } },
                ],
              },
            ],
            generationConfig: {
              // Asking for JSON at the API level rather than only in the prompt:
              // the model is then constrained rather than merely instructed.
              responseMimeType: 'application/json',
              // Zero temperature. Transcribing a document has one right answer, and
              // sampling variety is only useful where there is more than one.
              temperature: 0,
              maxOutputTokens: 8192,
            },
          }),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          return { ok: false, reason: describeHttpFailure(response.status, detail) };
        }

        const payload: unknown = await response.json();
        const text = firstTextPart(payload);

        if (text === null) {
          return {
            ok: false,
            reason: blockReason(payload) ?? 'The model returned no text.',
            raw: payload,
          };
        }

        try {
          const document = parseExtractedDocument(extractJsonObject(text));
          return { ok: true, document, raw: payload, usage: usageOf(payload) };
        } catch (err) {
          if (err instanceof UnreadableReplyError) {
            return { ok: false, reason: err.message, raw: payload };
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return { ok: false, reason: `The model did not answer within ${TIMEOUT_MS / 1000}s.` };
        }
        return {
          ok: false,
          reason: err instanceof Error ? `Could not reach the model: ${err.message}` : 'Unknown error',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * An HTTP failure in words a person can act on.
 *
 * The status alone ("429") tells a bookkeeper nothing. What they need is whether to
 * wait, to fix a setting, or to tell someone.
 */
function describeHttpFailure(status: number, detail: string): string {
  const trimmed = detail.slice(0, 400);
  if (status === 401 || status === 403) {
    return 'The AI key was refused. Check GEMINI_API_KEY in the environment settings.';
  }
  if (status === 429) {
    return 'The free tier’s rate limit has been reached. Wait a minute and try again.';
  }
  if (status === 400) {
    return `The model rejected the request, usually because the file type is not supported: ${trimmed}`;
  }
  if (status >= 500) {
    return 'The model is unavailable at the moment. Nothing was changed; try again shortly.';
  }
  return `The model returned HTTP ${status}: ${trimmed}`;
}

function firstTextPart(payload: unknown): string | null {
  const candidates = (payload as { candidates?: unknown[] })?.candidates;
  if (!Array.isArray(candidates)) return null;

  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown[] } })?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === 'string' && text.trim() !== '') return text;
    }
  }
  return null;
}

/**
 * Why the model declined, when it did.
 *
 * Worth surfacing rather than reporting as a generic failure: a safety filter
 * firing on an ordinary invoice means the document needs a human, and "no text" on
 * its own would leave a bookkeeper retrying for ever.
 */
function blockReason(payload: unknown): string | null {
  const feedback = (payload as { promptFeedback?: { blockReason?: unknown } })?.promptFeedback;
  if (typeof feedback?.blockReason === 'string') {
    return `The model declined to read this document (${feedback.blockReason}).`;
  }

  const finish = (payload as { candidates?: { finishReason?: unknown }[] })?.candidates?.[0]
    ?.finishReason;
  if (typeof finish === 'string' && finish !== 'STOP') {
    if (finish === 'MAX_TOKENS') {
      return 'The reply was cut off before it finished — the document has too many lines to read in one pass.';
    }
    return `The model stopped early (${finish}).`;
  }
  return null;
}

function usageOf(payload: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage = (payload as {
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  })?.usageMetadata;
  if (!usage) return undefined;
  return {
    inputTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
    outputTokens:
      typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined,
  };
}

/**
 * The provider the app uses, chosen from the environment.
 *
 * A missing key is not a crash and not a silent no-op: it throws something the
 * calling action turns into a message telling the owner exactly which setting to
 * add. The inbox still works without it — a document can be entered by hand — so an
 * absent key degrades the feature rather than the product.
 */
export function providerFromEnv(): ExtractionProvider {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ProviderUnavailableError(
      'No AI provider is configured. Add GEMINI_API_KEY to the environment to read documents ' +
        'automatically; until then, documents can be entered by hand from the Process page.',
    );
  }
  return geminiProvider({ apiKey, model: process.env.GEMINI_MODEL });
}
