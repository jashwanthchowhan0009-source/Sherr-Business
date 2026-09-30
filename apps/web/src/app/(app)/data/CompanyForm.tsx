'use client';

import { useTransition, useState } from 'react';
import { updateCompanyProfile } from '@/server/company';
import { ui } from '@/components/ui';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

export function CompanyForm({
  initial, readOnly,
}: {
  initial: {
    legalName: string; tradeName: string; pan: string; stateCode: string; fyStartMonth: number;
  };
  readOnly: boolean;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function onSubmit(formData: FormData) {
    setMessage(null);
    setFieldErrors({});
    start(async () => {
      const result = await updateCompanyProfile({
        legalName: String(formData.get('legalName') ?? ''),
        tradeName: String(formData.get('tradeName') ?? ''),
        pan: String(formData.get('pan') ?? ''),
        stateCode: String(formData.get('stateCode') ?? ''),
        fyStartMonth: Number(formData.get('fyStartMonth') ?? 4),
      });
      if (result.ok) {
        setMessage({ tone: 'ok', text: 'Saved. The change is in the audit history.' });
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        setMessage({ tone: 'err', text: result.error });
      }
    });
  }

  return (
    <form action={onSubmit}>
      <div className={ui.formGrid}>
        <Field name="legalName" label="Legal name" defaultValue={initial.legalName}
               errors={fieldErrors.legalName} disabled={readOnly} required />
        <Field name="tradeName" label="Trade name" defaultValue={initial.tradeName}
               errors={fieldErrors.tradeName} disabled={readOnly}
               hint="Optional. The name customers know you by." />
        <Field name="pan" label="PAN" defaultValue={initial.pan} errors={fieldErrors.pan}
               disabled={readOnly} placeholder="AAAAA9999A" hint="Ten characters, letters uppercase." />
        <Field name="stateCode" label="State code" defaultValue={initial.stateCode}
               errors={fieldErrors.stateCode} disabled={readOnly} placeholder="29"
               hint="Two digits, matching the first two of your GSTIN." />

        <div className={ui.field}>
          <label className={ui.label} htmlFor="fyStartMonth">Financial year starts</label>
          <select
            className={ui.input}
            id="fyStartMonth"
            name="fyStartMonth"
            defaultValue={initial.fyStartMonth}
            disabled={readOnly}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
          <span className={ui.hint}>April for almost every Indian company.</span>
        </div>
      </div>

      {!readOnly ? (
        <div className={ui.actions}>
          <button className={ui.button} type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </button>
          {message ? (
            <span className={`${ui.status} ${message.tone === 'ok' ? ui.statusOk : ui.statusErr}`}>
              {message.text}
            </span>
          ) : null}
        </div>
      ) : (
        <p className={ui.hint}>Your role can view these details but not change them.</p>
      )}
    </form>
  );
}

function Field({
  name, label, defaultValue, errors, disabled, hint, placeholder, required,
}: {
  name: string; label: string; defaultValue: string; errors?: string[];
  disabled: boolean; hint?: string; placeholder?: string; required?: boolean;
}) {
  return (
    <div className={ui.field}>
      <label className={ui.label} htmlFor={name}>{label}</label>
      <input
        className={ui.input}
        id={name}
        name={name}
        defaultValue={defaultValue}
        disabled={disabled}
        placeholder={placeholder}
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
