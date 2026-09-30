import {
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
import { createdAt, orgId, pk, updatedAt } from './columns';

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
export const TENANT_TABLES = [
  'org_registrations',
  'memberships',
  'invitations',
  'audit_logs',
  'account_groups',
  'accounts',
] as const;

/**
 * `organizations` is keyed by `id` rather than `org_id`, and `users` is global
 * identity visible only through a shared organization. Both are RLS-protected,
 * but their policies differ in shape, so they get their own assertions in
 * tests/integration/tenant-isolation.test.ts.
 */
export const SPECIAL_RLS_TABLES = ['organizations', 'users'] as const;

/**
 * Not tenant data. `rate_limits` holds counters keyed by actor and carries no
 * customer information; `schema_migrations` is DDL bookkeeping.
 */
export const SYSTEM_TABLES = ['rate_limits', 'schema_migrations'] as const;
