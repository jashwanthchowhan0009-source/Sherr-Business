'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useOrganizationList } from '@clerk/nextjs';
import { createCompany } from '@/server/onboarding';
import { REGISTRATION_TYPES } from '@/lib/db/schema';
import { STATE_CODES, validateGstin } from '@/lib/india/gstin';
import { stateFromPincode } from '@/lib/india/pincode';
import { ui } from '@/components/ui';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const REGISTRATION_LABELS: Record<(typeof REGISTRATION_TYPES)[number], string> = {
  regular: 'Regular',
  composition: 'Composition',
  unregistered: 'Unregistered',
};

const REGISTRATION_HINTS: Record<(typeof REGISTRATION_TYPES)[number], string> = {
  regular: 'Charges GST and claims input tax credit.',
  composition: 'Pays tax at a flat rate and cannot claim input tax credit.',
  unregistered: 'Not registered under GST. No GSTIN.',
};

/** Code → name, in name order, for the state picker. */
const STATES = Object.entries(STATE_CODES).sort((a, b) => a[1].localeCompare(b[1]));

/** 1 April of the financial year the books start in. */
function defaultBooksStart(): string {
  const now = new Date();
  const year = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

export function CompanyForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { setActive } = useOrganizationList();

  const [registrationType, setRegistrationType] =
    useState<(typeof REGISTRATION_TYPES)[number]>('regular');
  const [gstin, setGstin] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [pincode, setPincode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Derived live, so the checksum gives feedback before the form is submitted
  // rather than after a round trip.
  const derived = useMemo(() => {
    if (registrationType === 'unregistered' || gstin.trim().length === 0) return null;
    return validateGstin(gstin);
  }, [gstin, registrationType]);

  const registered = registrationType !== 'unregistered';

  // A valid GSTIN already says which state, so the picker follows it rather
  // than asking the same question twice — and a disagreement between the two is
  // impossible rather than merely reported.
  const stateFromGstin = derived?.ok ? derived.parts.stateCode : null;

  // Otherwise the PIN code narrows it. Most prefixes give one state, which is
  // preselected; the ones that span two offer both. It is a suggestion either
  // way: what the person leaves selected is what gets stored, because a wrong
  // state makes the tax on every invoice wrong without saying so.
  const suggestion = useMemo(() => stateFromPincode(pincode), [pincode]);
  const suggested = suggestion.certain ? suggestion.stateCodes[0]! : '';
  const effectiveStateCode = stateFromGstin ?? (stateCode || suggested);

  // When the PIN code points somewhere, the picker offers those states; when it
  // says nothing, it offers all of them.
  const stateOptions = suggestion.states.length > 0
    ? suggestion.states.map((st) => [st.code, st.name] as const)
    : STATES;

  function onSubmit(formData: FormData) {
    setError(null);
    setFieldErrors({});
    start(async () => {
      const result = await createCompany({
        legalName: String(formData.get('legalName') ?? ''),
        tradeName: String(formData.get('tradeName') ?? ''),
        registrationType,
        gstin: registered ? String(formData.get('gstin') ?? '') : '',
        pan: String(formData.get('pan') ?? ''),
        stateCode: effectiveStateCode,
        fyStartMonth: Number(formData.get('fyStartMonth') ?? 4),
        booksStartDate: String(formData.get('booksStartDate') ?? ''),
        baseCurrency: 'INR',
      });

      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        setError(result.error);
        return;
      }

      // The session carries no organization until one is made active, and
      // requireOrgContext reads exactly that — so without this the dashboard
      // would bounce straight back here.
      if (setActive) {
        await setActive({ organization: result.data.clerkOrgId });
      }
      router.push('/dashboard');
      router.refresh();
    });
  }

  return (
    <form action={onSubmit}>
      <div className={ui.formGrid}>
        <Field
          name="legalName" label="Registered legal name" required
          hint="As it appears on your certificate of incorporation."
          errors={fieldErrors.legalName}
        />
        <Field
          name="tradeName" label="Trade name"
          hint="Optional. What customers know you as."
          errors={fieldErrors.tradeName}
        />
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="registrationType">GST registration</label>
        <select
          className={ui.input}
          id="registrationType"
          value={registrationType}
          onChange={(e) =>
            setRegistrationType(e.target.value as (typeof REGISTRATION_TYPES)[number])
          }
        >
          {REGISTRATION_TYPES.map((t) => (
            <option key={t} value={t}>{REGISTRATION_LABELS[t]}</option>
          ))}
        </select>
        <span className={ui.hint}>{REGISTRATION_HINTS[registrationType]}</span>
      </div>

      {registered ? (
        <div className={ui.field}>
          <label className={ui.label} htmlFor="gstin">
            GSTIN <span className={ui.hint}>— optional</span>
          </label>
          <input
            className={ui.input}
            id="gstin"
            name="gstin"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            maxLength={15}
            autoComplete="off"
            spellCheck={false}
            style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '.04em' }}
          />
          {fieldErrors.gstin?.length ? (
            <span className={ui.error}>{fieldErrors.gstin.join(' ')}</span>
          ) : derived === null ? (
            <span className={ui.hint}>
              Add it now and your PAN and state are read from it. You can add it later instead —
              GST invoices and returns need it, nothing else does.
            </span>
          ) : derived.ok ? (
            <span className={ui.hint} style={{ color: 'var(--sb-verified)' }}>
              {derived.parts.stateName} · PAN {derived.parts.pan}
            </span>
          ) : (
            <span className={ui.error}>{derived.message}</span>
          )}
        </div>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="pincode">PIN code</label>
          <input
            className={ui.input}
            id="pincode"
            name="pincode"
            value={pincode}
            onChange={(e) => {
              setPincode(e.target.value.replace(/\D/g, '').slice(0, 6));
              // A new PIN code means a new suggestion, so an earlier manual
              // choice should not quietly survive it.
              setStateCode('');
            }}
            inputMode="numeric"
            autoComplete="postal-code"
            disabled={stateFromGstin !== null}
            style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '.04em' }}
          />
          <span className={ui.hint}>
            {stateFromGstin !== null
              ? 'Not needed — your state comes from the GSTIN.'
              : 'Where your business is. Used to work out your state.'}
          </span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="stateCode">State</label>
          <select
            className={ui.input}
            id="stateCode"
            value={effectiveStateCode}
            disabled={stateFromGstin !== null}
            onChange={(e) => setStateCode(e.target.value)}
          >
            <option value="">Choose a state…</option>
            {stateOptions.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
          {fieldErrors.stateCode?.length ? (
            <span className={ui.error}>{fieldErrors.stateCode.join(' ')}</span>
          ) : stateFromGstin !== null ? (
            <span className={ui.hint}>Read from your GSTIN.</span>
          ) : suggestion.certain ? (
            <span className={ui.hint} style={{ color: 'var(--sb-verified)' }}>
              From your PIN code. Change it if that is not right.
            </span>
          ) : suggestion.states.length > 1 ? (
            <span className={ui.hint}>
              That PIN code covers more than one state. Choose which.
            </span>
          ) : (
            <span className={ui.hint}>
              Decides whether a sale is CGST and SGST or IGST, so it is needed even without GST
              registration.
            </span>
          )}
        </div>

        {/* PAN is asked for only when there is no GSTIN to read it from. */}
        {stateFromGstin === null ? (
          <Field
            name="pan" label="PAN — optional"
            hint="Ten characters, like AAAAA9999A."
            errors={fieldErrors.pan}
          />
        ) : null}
      </div>

      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="fyStartMonth">Financial year starts</label>
          <select className={ui.input} id="fyStartMonth" name="fyStartMonth" defaultValue={4}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
          <span className={ui.hint}>April for almost every Indian company.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="booksStartDate">Books start from</label>
          <input
            className={ui.input}
            id="booksStartDate"
            name="booksStartDate"
            type="date"
            defaultValue={defaultBooksStart()}
            required
          />
          {fieldErrors.booksStartDate?.length ? (
            <span className={ui.error}>{fieldErrors.booksStartDate.join(' ')}</span>
          ) : (
            <span className={ui.hint}>No entry may be dated before this.</span>
          )}
        </div>
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create company'}
        </button>
        {error ? <span className={`${ui.status} ${ui.statusErr}`}>{error}</span> : null}
      </div>

      <p className={ui.hint} style={{ marginTop: 18 }}>
        A standard chart of accounts is created with the company, grouped for
        Schedule III. You can add to it afterwards. Amounts are in INR.
      </p>
    </form>
  );
}

function Field({
  name, label, errors, hint, required,
}: {
  name: string; label: string; errors?: string[];
  hint?: string; required?: boolean;
}) {
  return (
    <div className={ui.field}>
      <label className={ui.label} htmlFor={name}>{label}</label>
      <input
        className={ui.input}
        id={name}
        name={name}
        required={required}
        autoComplete="off"
      />
      {errors?.length ? (
        <span className={ui.error}>{errors.join(' ')}</span>
      ) : hint ? (
        <span className={ui.hint}>{hint}</span>
      ) : null}
    </div>
  );
}
