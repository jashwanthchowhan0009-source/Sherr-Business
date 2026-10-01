/**
 * What the model is asked.
 *
 * Versioned, and the version is stored with every extraction, because a prompt
 * change alters what the stored output means: an extraction from March read under
 * July's prompt would be interpreted against instructions it never saw.
 *
 * Three things the prompt does deliberately.
 *
 * It asks for text, never for arithmetic. The model is told in as many words not
 * to compute or correct anything, because a model that helpfully fixes a wrong
 * total destroys the one signal that would have caught the error.
 *
 * It asks for null rather than a guess, and says that a guess is worse than a gap.
 * A blank field costs a reviewer ten seconds; a plausible wrong GSTIN costs them
 * the rest of the day.
 *
 * It asks for a confidence per field, and says what the number is for — so that a
 * reviewer is pointed at the three fields worth re-reading rather than all twenty.
 */

export const PROMPT_VERSION = 'v1';

export const EXTRACTION_PROMPT = `You are reading a single Indian business document, usually a GST tax invoice.

Return ONLY a JSON object. No prose, no explanation, no markdown fence.

CRITICAL RULES

1. Transcribe, do not compute. Report every amount exactly as printed on the
   document, as a string, including its decimal places. Do NOT add anything up, do
   NOT recompute tax, and do NOT correct a total that looks wrong. If the document
   contradicts itself, report what it says. Somebody else checks the arithmetic, and
   a correction here would hide a real error.

2. Never guess. If a field is not on the document, or you cannot read it, use null.
   A null is handled; a plausible-looking wrong value is not. This matters most for
   GSTIN, invoice number, dates and amounts.

3. Give a confidence from 0 to 1 for every field: how sure you are that you read
   THAT FIELD correctly from THIS document. A person checks anything below 0.75, so
   be honest rather than polite — 0.5 on a smudged number is useful, 0.95 is not.

4. Dates: report exactly the characters printed, e.g. "03/04/2025" or "3 Apr 2025".
   Do not reformat and do not resolve the day/month order yourself.

SHAPE

{
  "kind": "purchase_invoice" | "sales_invoice" | "receipt" | "other",
  "kindReason": "one short sentence on why",
  "supplierName":   { "value": string|null, "confidence": number },
  "supplierGstin":  { "value": string|null, "confidence": number },
  "supplierStateCode": { "value": string|null, "confidence": number },
  "buyerName":      { "value": string|null, "confidence": number },
  "buyerGstin":     { "value": string|null, "confidence": number },
  "placeOfSupplyStateCode": { "value": string|null, "confidence": number },
  "invoiceNumber":  { "value": string|null, "confidence": number },
  "invoiceDate":    { "value": string|null, "confidence": number },
  "lines": [
    {
      "description":     { "value": string|null, "confidence": number },
      "hsnSac":          { "value": string|null, "confidence": number },
      "quantity":        { "value": string|null, "confidence": number },
      "unit":            { "value": string|null, "confidence": number },
      "rate":            { "value": string|null, "confidence": number },
      "taxableAmount":   { "value": string|null, "confidence": number },
      "gstRatePercent":  { "value": string|null, "confidence": number }
    }
  ],
  "statedTaxableTotal": { "value": string|null, "confidence": number },
  "statedCgst":       { "value": string|null, "confidence": number },
  "statedSgst":       { "value": string|null, "confidence": number },
  "statedIgst":       { "value": string|null, "confidence": number },
  "statedCess":       { "value": string|null, "confidence": number },
  "statedRoundOff":   { "value": string|null, "confidence": number },
  "statedGrandTotal": { "value": string|null, "confidence": number },
  "reverseCharge":    { "value": true|false|null, "confidence": number },
  "unreadable": ["anything on the document you could not read"]
}

NOTES

- "kind" is from the point of view of the person reading the document. If you
  cannot tell which direction it points, use "other" and say why. Guessing the
  direction wrong puts a purchase in the sales register.
- State codes are the two digits at the start of a GSTIN, e.g. "36" for Telangana.
- GSTIN is 15 characters. Report it as printed, without spaces.
- "reverseCharge" is true only if the document says tax is payable by the
  recipient or shows "reverse charge: yes". If it does not say, use null.
- Put anything smudged, cut off, handwritten or in a language you cannot read into
  "unreadable" rather than leaving it out silently.`;
