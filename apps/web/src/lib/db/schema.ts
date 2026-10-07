import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createdAt, orgId, paise, pk, updatedAt } from './columns';

/**
 * Phase 1 schema: tenancy, identity, roles, company profile, audit.
 *
 * Every table below is classified in TABLE_CLASSIFICATION at the bottom of this
 * file. tests/integration/tenant-isolation.test.ts asserts that the union of
 * those lists covers every table in the database, so a new table cannot be
 * added without a deliberate decision about its isolation.
 */

export const ROLES = ['owner', 'accountant', 'ca_reviewer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'suspended', 'expired'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const REGISTRATION_KINDS = ['gstin', 'tan', 'iec', 'msme', 'cin'] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export const REGISTRATION_TYPES = ['regular', 'composition', 'unregistered'] as const;
export type RegistrationType = (typeof REGISTRATION_TYPES)[number];

export const ACCOUNT_NATURES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountNatureValue = (typeof ACCOUNT_NATURES)[number];

// ── organizations ───────────────────────────────────────────────────────────

export const organizations = pgTable(
  'organizations',
  {
    id: pk(),
    clerkOrgId: text('clerk_org_id').notNull(),
    legalName: text('legal_name').notNull(),
    tradeName: text('trade_name'),
    pan: text('pan'),
    cin: text('cin'),
    stateCode: text('state_code'),
    /** 4 = April, the Indian financial year default. */
    fyStartMonth: integer('fy_start_month').notNull().default(4),
    /** GST registration type. Composition changes the tax engine's behaviour. */
    registrationType: text('registration_type').notNull().default('regular').$type<RegistrationType>(),
    /** No voucher may be dated before this. */
    booksStartDate: date('books_start_date'),
    baseCurrency: text('base_currency').notNull().default('INR'),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('organizations_clerk_org_id_key').on(t.clerkOrgId)],
);

// ── org_registrations ───────────────────────────────────────────────────────

export const orgRegistrations = pgTable(
  'org_registrations',
  {
    id: pk(),
    orgId: orgId(),
    kind: text('kind').notNull().$type<RegistrationKind>(),
    number: text('number').notNull(),
    stateCode: text('state_code'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('org_registrations_org_id_idx').on(t.orgId),
    uniqueIndex('org_registrations_org_kind_number_key').on(t.orgId, t.kind, t.number),
  ],
);

// ── users (global identity, RLS-scoped to shared organizations) ─────────────

export const users = pgTable(
  'users',
  {
    id: pk(),
    clerkUserId: text('clerk_user_id').notNull(),
    email: text('email').notNull(),
    fullName: text('full_name'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_clerk_user_id_key').on(t.clerkUserId)],
);

// ── memberships (the role of record) ────────────────────────────────────────

export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    orgId: orgId(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull().$type<Role>(),
    /** Reserved for branch / period scoping (blueprint §6). Unused in Phase 1. */
    scope: jsonb('scope'),
    invitedBy: uuid('invited_by'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    /** External CA and auditor access expires by default. NULL = no expiry. */
    validTo: timestamp('valid_to', { withTimezone: true }),
    status: text('status').notNull().default('active').$type<MembershipStatus>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('memberships_org_user_key').on(t.orgId, t.userId),
    index('memberships_user_id_idx').on(t.userId),
  ],
);

// ── invitations ─────────────────────────────────────────────────────────────

export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    orgId: orgId(),
    email: text('email').notNull(),
    role: text('role').notNull().$type<Role>(),
    /** SHA-256 of the token. The raw token is shown once and never stored. */
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitations_org_id_idx').on(t.orgId),
    uniqueIndex('invitations_token_hash_key').on(t.tokenHash),
  ],
);

// ── audit_logs (append-only; enforced by grant, not by convention) ──────────

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    orgId: orgId(),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_at_idx').on(t.orgId, t.at),
    index('audit_logs_subject_idx').on(t.orgId, t.subjectKind, t.subjectId),
  ],
);

// ── account_groups / accounts (the chart of accounts) ──────────────────────

export const accountGroups = pgTable(
  'account_groups',
  {
    id: pk(),
    orgId: orgId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    nature: text('nature').notNull().$type<AccountNatureValue>(),
    /** Where this group presents on the Schedule III face. */
    bucket: text('bucket').notNull(),
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('account_groups_org_code_key').on(t.orgId, t.code),
    index('account_groups_org_parent_idx').on(t.orgId, t.parentId),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: pk(),
    orgId: orgId(),
    groupId: uuid('group_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Inherited from the group; never set independently. */
    nature: text('nature').notNull().$type<AccountNatureValue>(),
    /** Referenced by code by the calculation engines, so it cannot be deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('accounts_org_code_key').on(t.orgId, t.code),
    index('accounts_org_group_idx').on(t.orgId, t.groupId),
  ],
);

// ── rate_limits (system table; keyed by actor, not by tenant) ───────────────

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [index('rate_limits_window_start_idx').on(t.windowStart)],
);

// ── relations ───────────────────────────────────────────────────────────────

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  registrations: many(orgRegistrations),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.orgId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const orgRegistrationsRelations = relations(orgRegistrations, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgRegistrations.orgId],
    references: [organizations.id],
  }),
}));

// ── isolation classification ────────────────────────────────────────────────

/**
 * Tables whose rows belong to exactly one organization, discriminated by
 * `org_id`. RLS policy is `org_id = current_setting('app.current_org_id')`.
 */
// ════════════════════════════════════════════════════════════════════════════
// Step B: parties, items, versioned tax rules, and the voucher core.
//
// Two invariants on these tables are enforced by database triggers rather than
// here — every posted voucher balances, and a posted voucher is immutable. See
// drizzle/0003_ledger_and_sales.sql. Application code must not assume it is the
// only guard.
// ════════════════════════════════════════════════════════════════════════════

export const TAX_RULE_KINDS = ['gst_rate', 'tds_section', 'cess', 'other'] as const;
export type TaxRuleKind = (typeof TAX_RULE_KINDS)[number];

export const taxRules = pgTable(
  'tax_rules',
  {
    id: pk(),
    /** Null for a rule shipped with the product; set for a company override. */
    orgId: uuid('org_id'),
    kind: text('kind').notNull().$type<TaxRuleKind>(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    rateBps: integer('rate_bps'),
    thresholdSinglePaise: paise('threshold_single_paise'),
    thresholdAnnualPaise: paise('threshold_annual_paise'),
    section: text('section'),
    sectionLegacy: text('section_legacy'),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    /** True until a qualified professional signs the rule off. */
    needsCaVerification: boolean('needs_ca_verification').notNull().default(true),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    sourceNote: text('source_note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('tax_rules_lookup_idx').on(t.kind, t.code, t.effectiveFrom),
    index('tax_rules_org_idx').on(t.orgId),
  ],
);

export const PARTY_KINDS = ['customer', 'supplier', 'both'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const parties = pgTable(
  'parties',
  {
    id: pk(),
    orgId: orgId(),
    kind: text('kind').notNull().$type<PartyKind>(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    gstin: text('gstin'),
    pan: text('pan'),
    stateCode: text('state_code'),
    /**
     * Where a supply to this party is taxed. Defaults to their own state, but
     * an invoice may override it: the place of supply is not always the
     * billing address.
     */
    placeOfSupplyStateCode: text('place_of_supply_state_code'),
    email: text('email'),
    phone: text('phone'),
    billingAddress: text('billing_address'),
    creditDays: integer('credit_days').notNull().default(0),
    creditLimitPaise: paise('credit_limit_paise'),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('parties_org_kind_idx').on(t.orgId, t.kind),
    uniqueIndex('parties_org_gstin_key').on(t.orgId, t.gstin),
  ],
);

export const ITEM_KINDS = ['goods', 'service'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const items = pgTable(
  'items',
  {
    id: pk(),
    orgId: orgId(),
    code: text('code'),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('goods').$type<ItemKind>(),
    /** HSN for goods, SAC for services. Four to eight digits. */
    hsnSac: text('hsn_sac'),
    unit: text('unit').notNull().default('NOS'),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    cessRateBps: integer('cess_rate_bps').notNull().default(0),
    salePricePaise: paise('sale_price_paise'),
    purchasePricePaise: paise('purchase_price_paise'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('items_org_code_key').on(t.orgId, t.code)],
);

export const numberSeries = pgTable(
  'number_series',
  {
    id: pk(),
    orgId: orgId(),
    voucherType: text('voucher_type').notNull(),
    fyLabel: text('fy_label').notNull(),
    prefix: text('prefix').notNull(),
    nextNumber: integer('next_number').notNull().default(1),
    width: integer('width').notNull().default(4),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('number_series_org_type_fy_key').on(t.orgId, t.voucherType, t.fyLabel)],
);

export const VOUCHER_TYPES = [
  'sales',
  'purchase',
  'receipt',
  'payment',
  'contra',
  'journal',
  'credit_note',
  'debit_note',
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

export const VOUCHER_STATUSES = ['draft', 'posted'] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

export const SUPPLY_TYPES = ['intra_state', 'inter_state', 'zero_rated', 'exempt'] as const;
export type SupplyTypeValue = (typeof SUPPLY_TYPES)[number];

export const vouchers = pgTable(
  'vouchers',
  {
    id: pk(),
    orgId: orgId(),
    voucherType: text('voucher_type').notNull().$type<VoucherType>(),
    voucherNo: text('voucher_no').notNull(),
    fyLabel: text('fy_label').notNull(),
    voucherDate: date('voucher_date').notNull(),
    partyId: uuid('party_id'),
    /**
     * Frozen onto the voucher at posting. The states that decided CGST/SGST
     * versus IGST must not change if the party is edited afterwards.
     */
    supplierStateCode: text('supplier_state_code'),
    placeOfSupplyStateCode: text('place_of_supply_state_code'),
    supplyType: text('supply_type').$type<SupplyTypeValue>(),
    reference: text('reference'),
    /**
     * The supplier's own invoice number, from their document. Distinct from
     * `voucherNo`, which is ours: only the supplier's can detect the same bill
     * entered twice, which is the most expensive data-entry error in payables.
     */
    supplierInvoiceNo: text('supplier_invoice_no'),
    supplierInvoiceDate: date('supplier_invoice_date'),
    narration: text('narration'),
    taxablePaise: paise('taxable_paise').notNull().default(0n),
    cgstPaise: paise('cgst_paise').notNull().default(0n),
    sgstPaise: paise('sgst_paise').notNull().default(0n),
    igstPaise: paise('igst_paise').notNull().default(0n),
    cessPaise: paise('cess_paise').notNull().default(0n),
    roundOffPaise: paise('round_off_paise').notNull().default(0n),
    totalPaise: paise('total_paise').notNull().default(0n),
    status: text('status').notNull().default('draft').$type<VoucherStatus>(),
    /** The only column a posted voucher may ever have written to it. */
    reversedByVoucherId: uuid('reversed_by_voucher_id'),
    reversesVoucherId: uuid('reverses_voucher_id'),
    sourceDocumentId: uuid('source_document_id'),
    /** The order and receipt a bill relates to, for the three-way match. */
    poId: uuid('po_id'),
    grnId: uuid('grn_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vouchers_org_type_fy_no_key').on(t.orgId, t.voucherType, t.fyLabel, t.voucherNo),
    index('vouchers_org_date_idx').on(t.orgId, t.voucherDate),
    index('vouchers_org_party_idx').on(t.orgId, t.partyId),
    index('vouchers_org_status_idx').on(t.orgId, t.status),
  ],
);

export const voucherLines = pgTable(
  'voucher_lines',
  {
    id: pk(),
    orgId: orgId(),
    voucherId: uuid('voucher_id').notNull(),
    lineNo: integer('line_no').notNull(),
    itemId: uuid('item_id'),
    description: text('description').notNull(),
    hsnSac: text('hsn_sac'),
    unit: text('unit'),
    /** Scaled by QTY_SCALE (10000): four decimal places, integers throughout. */
    quantity: bigint('quantity', { mode: 'bigint' }).notNull().default(10000n),
    unitPricePaise: paise('unit_price_paise').notNull().default(0n),
    discountPaise: paise('discount_paise').notNull().default(0n),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    cessRateBps: integer('cess_rate_bps').notNull().default(0),
    taxablePaise: paise('taxable_paise').notNull().default(0n),
    cgstPaise: paise('cgst_paise').notNull().default(0n),
    sgstPaise: paise('sgst_paise').notNull().default(0n),
    igstPaise: paise('igst_paise').notNull().default(0n),
    cessPaise: paise('cess_paise').notNull().default(0n),
    lineTotalPaise: paise('line_total_paise').notNull().default(0n),
    reverseCharge: boolean('reverse_charge').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('voucher_lines_voucher_line_key').on(t.voucherId, t.lineNo),
    index('voucher_lines_org_idx').on(t.orgId),
  ],
);

export const TAX_HEADS = ['cgst', 'sgst', 'igst', 'cess'] as const;
export type TaxHead = (typeof TAX_HEADS)[number];

export const taxLines = pgTable(
  'tax_lines',
  {
    id: pk(),
    orgId: orgId(),
    voucherId: uuid('voucher_id').notNull(),
    head: text('head').notNull().$type<TaxHead>(),
    rateBps: integer('rate_bps').notNull(),
    taxablePaise: paise('taxable_paise').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('tax_lines_voucher_idx').on(t.voucherId), index('tax_lines_org_idx').on(t.orgId)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: pk(),
    orgId: orgId(),
    voucherId: uuid('voucher_id').notNull(),
    accountId: uuid('account_id').notNull(),
    partyId: uuid('party_id'),
    entryDate: date('entry_date').notNull(),
    /** Exactly one of these two is positive. Enforced by a check constraint. */
    debitPaise: paise('debit_paise').notNull().default(0n),
    creditPaise: paise('credit_paise').notNull().default(0n),
    narration: text('narration'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_org_account_date_idx').on(t.orgId, t.accountId, t.entryDate),
    index('ledger_entries_voucher_idx').on(t.voucherId),
    index('ledger_entries_org_party_idx').on(t.orgId, t.partyId),
  ],
);

export const voucherAllocations = pgTable(
  'voucher_allocations',
  {
    id: pk(),
    orgId: orgId(),
    /** The receipt or payment. */
    settlementVoucherId: uuid('settlement_voucher_id').notNull(),
    /** The invoice or bill being settled. */
    targetVoucherId: uuid('target_voucher_id').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('voucher_allocations_pair_key').on(t.settlementVoucherId, t.targetVoucherId),
    index('voucher_allocations_target_idx').on(t.targetVoucherId),
  ],
);

/**
 * What the uploader says a document is, matching the input-type chips in the
 * Input design.
 *
 * It is a claim, not a fact: nothing validates it, and no number anywhere is
 * derived from it. Classification and extraction arrive in step H, and will
 * record their own answer separately rather than overwriting what a person
 * said.
 */
export const DECLARED_DOCUMENT_TYPES = [
  'sales_invoice',
  'credit_note',
  'purchase_bill',
  'purchase_order',
  'bank_statement',
  'cashbook',
  'party_ledger',
  'expense',
  'asset',
  'inventory',
  'payroll',
  'other',
] as const;
export type DeclaredDocumentType = (typeof DECLARED_DOCUMENT_TYPES)[number];

/** Chip labels, in the order the Input screen shows them. */
export const DECLARED_DOCUMENT_TYPE_LABELS: Record<DeclaredDocumentType, string> = {
  sales_invoice: 'Sales invoices',
  credit_note: 'Credit notes',
  purchase_bill: 'Purchase bills',
  purchase_order: "PO's",
  bank_statement: 'Bank statements',
  cashbook: 'Cashbook',
  party_ledger: 'Customer and supplier ledgers',
  expense: 'Expenses',
  asset: 'Assets',
  inventory: 'Inventory',
  payroll: 'Payroll',
  other: 'Something else',
};

export const DOCUMENT_STATUSES = [
  'stored',
  'extracting',
  'extracted',
  'needs_review',
  'posted',
  'rejected',
  'superseded',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documents = pgTable(
  'documents',
  {
    id: pk(),
    orgId: orgId(),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    /** SHA-256 of the bytes: the duplicate gate, before anything is read. */
    contentHash: text('content_hash').notNull(),
    /** What the uploader said it is. AI classification arrives in step H. */
    declaredType: text('declared_type'),
    declaredLabel: text('declared_label'),
    status: text('status').notNull().default('stored').$type<DocumentStatus>(),
    uploadedBy: uuid('uploaded_by'),
    linkedVoucherId: uuid('linked_voucher_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('documents_org_created_idx').on(t.orgId, t.createdAt),
    uniqueIndex('documents_org_hash_key').on(t.orgId, t.contentHash),
  ],
);


// ════════════════════════════════════════════════════════════════════════════
// Step E: bank statement import, matching and reconciliation, plus the
// purchase order → goods receipt → bill three-way match.
// ════════════════════════════════════════════════════════════════════════════

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: pk(),
    orgId: orgId(),
    /** The ledger account this bank account posts to. */
    ledgerAccountId: uuid('ledger_account_id').notNull(),
    bankName: text('bank_name').notNull(),
    accountLabel: text('account_label').notNull(),
    /** Last four digits only: the full number is not needed to reconcile. */
    accountNumberLast4: text('account_number_last4'),
    ifsc: text('ifsc'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('bank_accounts_org_idx').on(t.orgId)],
);

export const bankStatements = pgTable(
  'bank_statements',
  {
    id: pk(),
    orgId: orgId(),
    bankAccountId: uuid('bank_account_id').notNull(),
    /** The uploaded file this was parsed from, so a figure traces to a document. */
    documentId: uuid('document_id'),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    openingBalancePaise: paise('opening_balance_paise'),
    closingBalancePaise: paise('closing_balance_paise'),
    lineCount: integer('line_count').notNull().default(0),
    problemCount: integer('problem_count').notNull().default(0),
    /** Whether the statement's own running balance added up on import. */
    balanceConsistent: boolean('balance_consistent').notNull().default(true),
    importedBy: uuid('imported_by'),
    createdAt: createdAt(),
  },
  (t) => [index('bank_statements_org_account_idx').on(t.orgId, t.bankAccountId, t.periodFrom)],
);

export const BANK_LINE_STATUSES = ['unmatched', 'suggested', 'reconciled', 'ignored'] as const;
export type BankLineStatus = (typeof BANK_LINE_STATUSES)[number];

export const bankStatementLines = pgTable(
  'bank_statement_lines',
  {
    id: pk(),
    orgId: orgId(),
    statementId: uuid('statement_id').notNull(),
    bankAccountId: uuid('bank_account_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    lineDate: date('line_date').notNull(),
    narration: text('narration').notNull(),
    reference: text('reference'),
    /** Positive is money in, negative is money out. */
    amountPaise: paise('amount_paise').notNull(),
    balancePaise: paise('balance_paise'),
    status: text('status').notNull().default('unmatched').$type<BankLineStatus>(),
    matchedVoucherId: uuid('matched_voucher_id'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    reconciledBy: uuid('reconciled_by'),
    /** Fingerprint of the transaction, so one statement imported twice is idempotent. */
    fingerprint: text('fingerprint').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bank_statement_lines_fingerprint_key').on(t.orgId, t.bankAccountId, t.fingerprint),
    index('bank_statement_lines_status_idx').on(t.orgId, t.bankAccountId, t.status, t.lineDate),
  ],
);

export const MATCH_TIERS = ['exact', 'strong', 'probable', 'weak'] as const;
export type MatchTierValue = (typeof MATCH_TIERS)[number];

export const bankMatchSuggestions = pgTable(
  'bank_match_suggestions',
  {
    id: pk(),
    orgId: orgId(),
    statementLineId: uuid('statement_line_id').notNull(),
    voucherId: uuid('voucher_id').notNull(),
    tier: text('tier').notNull().$type<MatchTierValue>(),
    confidence: integer('confidence').notNull(),
    reasons: jsonb('reasons').notNull().default([]),
    dayDifference: integer('day_difference').notNull().default(0),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by'),
    decision: text('decision').$type<'accepted' | 'rejected'>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bank_match_suggestions_pair_key').on(t.statementLineId, t.voucherId),
    index('bank_match_suggestions_org_idx').on(t.orgId),
  ],
);

export const PO_STATUSES = ['open', 'part_received', 'received', 'closed', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/**
 * A purchase order. Not an accounting voucher: ordering goods changes no ledger
 * balance. It exists so a bill can be checked against what was ordered.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: pk(),
    orgId: orgId(),
    poNo: text('po_no').notNull(),
    fyLabel: text('fy_label').notNull(),
    poDate: date('po_date').notNull(),
    partyId: uuid('party_id').notNull(),
    expectedDate: date('expected_date'),
    narration: text('narration'),
    totalPaise: paise('total_paise').notNull().default(0n),
    status: text('status').notNull().default('open').$type<PoStatus>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('purchase_orders_org_no_key').on(t.orgId, t.fyLabel, t.poNo)],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: pk(),
    orgId: orgId(),
    poId: uuid('po_id').notNull(),
    lineNo: integer('line_no').notNull(),
    itemId: uuid('item_id'),
    description: text('description').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    unit: text('unit'),
    unitPricePaise: paise('unit_price_paise').notNull().default(0n),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('purchase_order_lines_po_line_key').on(t.poId, t.lineNo)],
);

/** A goods receipt against a supplier's delivery challan. */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: pk(),
    orgId: orgId(),
    grnNo: text('grn_no').notNull(),
    fyLabel: text('fy_label').notNull(),
    receiptDate: date('receipt_date').notNull(),
    partyId: uuid('party_id').notNull(),
    poId: uuid('po_id'),
    /** The supplier's challan number, from their document. */
    challanNo: text('challan_no'),
    challanDate: date('challan_date'),
    narration: text('narration'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('goods_receipts_org_no_key').on(t.orgId, t.fyLabel, t.grnNo)],
);

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: pk(),
    orgId: orgId(),
    grnId: uuid('grn_id').notNull(),
    poLineId: uuid('po_line_id'),
    lineNo: integer('line_no').notNull(),
    itemId: uuid('item_id'),
    description: text('description').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    unit: text('unit'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('goods_receipt_lines_grn_line_key').on(t.grnId, t.lineNo)],
);

/**
 * A GSTR-2B file downloaded from the portal.
 *
 * The parsed invoices are kept, not only the reconciliation, so the comparison
 * can be re-run against the books as they stand later: what the portal said is a
 * fact about the portal, what the books say is a fact about the books, and the
 * difference between them moves as bills are entered.
 */
export const gstr2bUploads = pgTable(
  'gstr2b_uploads',
  {
    id: pk(),
    orgId: orgId(),
    documentId: uuid('document_id'),
    /** The period as the portal states it: '062025'. */
    period: text('period'),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    /** Our GSTIN as the file states it, so a file for another company is caught. */
    statedGstin: text('stated_gstin'),
    invoiceCount: integer('invoice_count').notNull().default(0),
    problemCount: integer('problem_count').notNull().default(0),
    /** Amounts held as strings, so no figure passes through a float. */
    invoices: jsonb('invoices').notNull().default([]),
    uploadedBy: uuid('uploaded_by'),
    createdAt: createdAt(),
  },
  (t) => [index('gstr2b_uploads_org_period_idx').on(t.orgId, t.periodFrom)],
);

/**
 * Period locking. Step F locks periods properly; the table exists from step C
 * so the voucher-date trigger has somewhere to read from, and so the later
 * change adds behaviour rather than schema to a table holding real vouchers.
 */
export const periodLocks = pgTable(
  'period_locks',
  {
    id: pk(),
    orgId: orgId(),
    /** Nothing dated on or before this may be posted. */
    lockedUpto: date('locked_upto').notNull(),
    reason: text('reason'),
    lockedBy: uuid('locked_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('period_locks_org_key').on(t.orgId)],
);

/**
 * What a model said about a document, what our checks made of it, and what a
 * person decided.
 *
 * All three are kept. The figures that reach the ledger come from `reviewed`, but
 * the question an audit trail is asked six months later is not "what is the
 * number" — it is "where did this come from and who agreed to it", and only the
 * model's own reply alongside the reviewed values answers that.
 */
export const documentExtractions = pgTable(
  'document_extractions',
  {
    id: pk(),
    orgId: orgId(),
    documentId: uuid('document_id').notNull(),
    /** Who answered, and under which prompt. */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: text('status').notNull().default('pending'),
    failureReason: text('failure_reason'),
    /** The model's claims. Amounts are strings: claims, not accounting values. */
    extracted: jsonb('extracted'),
    rawResponse: jsonb('raw_response'),
    /** Our own findings and recomputed totals. */
    validation: jsonb('validation'),
    /** What the reviewer settled on. Null until somebody has looked. */
    reviewed: jsonb('reviewed'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** The draft voucher it became. A draft — approving never posts. */
    voucherId: uuid('voucher_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: createdAt(),
  },
  (t) => [
    index('document_extractions_org_created_idx').on(t.orgId, t.createdAt),
    index('document_extractions_document_idx').on(t.orgId, t.documentId),
  ],
);

// ─── ERP modules (shallow scaffold) ─────────────────────────────────────────
//
// Step J. Four modules, one or two tables deep, on top of the accounting core
// above. None of these post to the ledger or touch a voucher — see the banner
// comment in drizzle/0011_erp_modules_shallow.sql for the boundary this draws.

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const DEAL_ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting', 'stage_change'] as const;
export type DealActivityKind = (typeof DEAL_ACTIVITY_KINDS)[number];

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: pk(),
    orgId: orgId(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isWon: boolean('is_won').notNull().default(false),
    isLost: boolean('is_lost').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pipeline_stages_org_name_key').on(t.orgId, t.name),
    index('pipeline_stages_org_sort_idx').on(t.orgId, t.sortOrder),
  ],
);

export const deals = pgTable(
  'deals',
  {
    id: pk(),
    orgId: orgId(),
    partyId: uuid('party_id'),
    stageId: uuid('stage_id').notNull(),
    title: text('title').notNull(),
    valuePaise: paise('value_paise').notNull().default(0n),
    expectedCloseDate: date('expected_close_date'),
    status: text('status').notNull().default('open').$type<DealStatus>(),
    ownerUserId: uuid('owner_user_id'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('deals_org_stage_idx').on(t.orgId, t.stageId),
    index('deals_org_status_idx').on(t.orgId, t.status),
  ],
);

export const dealActivities = pgTable(
  'deal_activities',
  {
    id: pk(),
    orgId: orgId(),
    dealId: uuid('deal_id').notNull(),
    kind: text('kind').notNull().default('note').$type<DealActivityKind>(),
    body: text('body'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('deal_activities_org_deal_idx').on(t.orgId, t.dealId, t.createdAt)],
);

export const STOCK_MOVEMENT_TYPES = [
  'receipt',
  'issue',
  'transfer_in',
  'transfer_out',
  'adjustment',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const warehouses = pgTable(
  'warehouses',
  {
    id: pk(),
    orgId: orgId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('warehouses_org_code_key').on(t.orgId, t.code)],
);

/** Quantity columns use the same scaled-bigint convention as voucher_lines.quantity (×10,000). */
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: pk(),
    orgId: orgId(),
    itemId: uuid('item_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    quantityOnHand: bigint('quantity_on_hand', { mode: 'bigint' }).notNull().default(0n),
    reorderPoint: bigint('reorder_point', { mode: 'bigint' }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('stock_levels_org_item_warehouse_key').on(t.orgId, t.itemId, t.warehouseId)],
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: pk(),
    orgId: orgId(),
    itemId: uuid('item_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    movementType: text('movement_type').notNull().$type<StockMovementType>(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    referenceKind: text('reference_kind'),
    referenceId: text('reference_id'),
    note: text('note'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('stock_movements_org_item_idx').on(t.orgId, t.itemId, t.createdAt),
    index('stock_movements_org_warehouse_idx').on(t.orgId, t.warehouseId, t.createdAt),
  ],
);

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'exited'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const PAYROLL_RUN_STATUSES = ['draft', 'approved', 'paid'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const departments = pgTable(
  'departments',
  {
    id: pk(),
    orgId: orgId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('departments_org_name_key').on(t.orgId, t.name)],
);

export const employees = pgTable(
  'employees',
  {
    id: pk(),
    orgId: orgId(),
    userId: uuid('user_id'),
    departmentId: uuid('department_id'),
    fullName: text('full_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    designation: text('designation'),
    employmentType: text('employment_type').notNull().default('full_time').$type<EmploymentType>(),
    dateOfJoining: date('date_of_joining'),
    dateOfExit: date('date_of_exit'),
    status: text('status').notNull().default('active').$type<EmployeeStatus>(),
    /** Informational only until a later integration decides how CTC meets the ledger. */
    monthlyCtcPaise: paise('monthly_ctc_paise'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('employees_org_department_idx').on(t.orgId, t.departmentId),
    index('employees_org_status_idx').on(t.orgId, t.status),
  ],
);

export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: pk(),
    orgId: orgId(),
    periodMonth: integer('period_month').notNull(),
    periodYear: integer('period_year').notNull(),
    status: text('status').notNull().default('draft').$type<PayrollRunStatus>(),
    totalGrossPaise: paise('total_gross_paise').notNull().default(0n),
    totalDeductionsPaise: paise('total_deductions_paise').notNull().default(0n),
    totalNetPaise: paise('total_net_paise').notNull().default(0n),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payroll_runs_org_period_key').on(t.orgId, t.periodYear, t.periodMonth),
  ],
);

export const payslips = pgTable(
  'payslips',
  {
    id: pk(),
    orgId: orgId(),
    payrollRunId: uuid('payroll_run_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    grossPaise: paise('gross_paise').notNull().default(0n),
    deductionsPaise: paise('deductions_paise').notNull().default(0n),
    netPaise: paise('net_paise').notNull().default(0n),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payslips_org_run_employee_key').on(t.orgId, t.payrollRunId, t.employeeId),
  ],
);

export const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    orgId: orgId(),
    partyId: uuid('party_id'),
    name: text('name').notNull(),
    status: text('status').notNull().default('active').$type<ProjectStatus>(),
    startDate: date('start_date'),
    dueDate: date('due_date'),
    ownerUserId: uuid('owner_user_id'),
    budgetPaise: paise('budget_paise'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_org_status_idx').on(t.orgId, t.status)],
);

export const projectTasks = pgTable(
  'project_tasks',
  {
    id: pk(),
    orgId: orgId(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('todo').$type<ProjectTaskStatus>(),
    assigneeUserId: uuid('assignee_user_id'),
    dueDate: date('due_date'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('project_tasks_org_project_idx').on(t.orgId, t.projectId)],
);

export const TENANT_TABLES = [
  'org_registrations',
  'memberships',
  'invitations',
  'audit_logs',
  'account_groups',
  'accounts',
  'parties',
  'items',
  'number_series',
  'vouchers',
  'voucher_lines',
  'tax_lines',
  'ledger_entries',
  'voucher_allocations',
  'documents',
  'period_locks',
  'bank_accounts',
  'bank_statements',
  'bank_statement_lines',
  'bank_match_suggestions',
  'purchase_orders',
  'purchase_order_lines',
  'goods_receipts',
  'goods_receipt_lines',
  'gstr2b_uploads',
  'document_extractions',
  // ERP modules (shallow scaffold) — Step J.
  'pipeline_stages',
  'deals',
  'deal_activities',
  'warehouses',
  'stock_levels',
  'stock_movements',
  'departments',
  'employees',
  'payroll_runs',
  'payslips',
  'projects',
  'project_tasks',
] as const;

/**
 * `organizations` is keyed by `id` rather than `org_id`, and `users` is global
 * identity visible only through a shared organization. Both are RLS-protected,
 * but their policies differ in shape, so they get their own assertions in
 * tests/integration/tenant-isolation.test.ts.
 */
/**
 * The screen lock's PIN. Per user, hashed with a per-user salt.
 */
export const userPins = pgTable('user_pins', {
  userId: uuid('user_id').primaryKey(),
  pinHash: text('pin_hash').notNull(),
  salt: text('salt').notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A live unlock. The browser holds the token; this holds its hash. */
export const pinUnlocks = pgTable(
  'pin_unlocks',
  {
    id: pk(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('pin_unlocks_user_idx').on(t.userId)],
);

/** Isolated by user rather than by organization. */
export const SPECIAL_RLS_TABLES = ['organizations', 'users', 'user_pins', 'pin_unlocks'] as const;

/**
 * Not tenant data. `rate_limits` holds counters keyed by actor and carries no
 * customer information; `schema_migrations` is DDL bookkeeping.
 */
export const SYSTEM_TABLES = ['rate_limits', 'schema_migrations'] as const;

/**
 * `tax_rules` is the one table that deliberately holds rows visible to every
 * tenant: a product-wide rule has `org_id = null`, and a company may add its
 * own override. Its policy therefore admits `org_id is null or org_id =
 * app_current_org_id()`, which the uniform tenant assertion would reject, so it
 * gets its own test rather than being silently exempted.
 */
export const SHARED_REFERENCE_TABLES = ['tax_rules'] as const;
