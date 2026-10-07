import type { Role } from '@/lib/db/schema';

/**
 * Every capability the application can gate on. Adding a capability here without
 * adding it to ROLE_CAPABILITIES is a type error, so a new capability cannot be
 * introduced without deciding who holds it.
 */
export const CAPABILITIES = [
  'org:read',
  'org:update',
  'company:read',
  'company:update',
  'registration:read',
  'registration:write',
  'member:read',
  'member:invite',
  'member:update_role',
  'member:remove',
  'invite:read',
  'invite:revoke',
  'audit:read',

  // Step B: the ledger. Reading and drafting are separated from posting,
  // because posting is what makes a voucher immutable and puts a number into
  // the books. A ca_reviewer may read everything and post nothing.
  'party:read',
  'party:write',
  'item:read',
  'item:write',
  'voucher:read',
  'voucher:draft',
  'voucher:post',
  'document:read',
  'document:upload',
  'taxrule:read',
  'taxrule:verify',

  // Step E: banking. Importing a statement is separate from reconciling it,
  // because importing changes nothing and reconciling asserts that the bank
  // agrees with the books.
  'bank:read',
  'bank:import',
  'bank:reconcile',
  'procurement:read',
  'procurement:write',

  // Step F: closing the books. Locking a period is the act that turns a
  // provisional figure into a settled one, so it sits with the owner alone —
  // an accountant maintains the books, the owner decides they are final.
  'period:lock',
  'period:unlock',
  'closing:write',

  // Step H: the AI inbox. Reading a document with a model is its own capability
  // because it is its own decision: it sends the document to a third party and it
  // costs money. Approving what the model read needs 'voucher:draft' as well,
  // since an approval produces a draft voucher — approving is bookkeeping, and
  // nothing about an AI reading a file changes who may enter a transaction.
  'document:extract',

  // Step J: the ERP module scaffold (CRM, inventory ops, HR, projects).
  // None of these roles yet exist as dedicated owners of a module — a sales
  // rep, an HR manager, a warehouse lead. Until they do, write access to each
  // module sits with 'owner' alone (ROLE_CAPABILITIES.owner is ALL, below);
  // the other three roles get read-only so the data is visible without
  // deciding, here, who outside the accounting roles should be allowed to
  // change it.
  'crm:read',
  'crm:write',
  'inventory_ops:read',
  'inventory_ops:write',
  'hr:read',
  'hr:write',
  'project:read',
  'project:write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: readonly Capability[] = CAPABILITIES;

/**
 * Roles are deliberately narrow. Notes on the less obvious choices:
 *
 * - `accountant` may maintain the company profile and registrations (that is the
 *   job) but may not change who has access. Managing people is an owner action.
 * - `ca_reviewer` is read-only on data and is one of only two roles that can read
 *   the audit log. A reviewer who cannot see who changed what cannot review.
 * - `ca_reviewer` holds `taxrule:verify` but no writing capability at all: a CA
 *   signs a rate off, and nobody else can, but signing a rule off is not the
 *   same as entering a transaction.
 * - `viewer` can read vouchers but holds no `voucher:draft`. A read-only role
 *   that can create drafts is not read-only.
 */
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  owner: ALL,
  accountant: [
    'org:read',
    'company:read',
    'company:update',
    'registration:read',
    'registration:write',
    'member:read',
    'invite:read',
    'party:read',
    'party:write',
    'item:read',
    'item:write',
    'voucher:read',
    'voucher:draft',
    'voucher:post',
    'document:read',
    'document:upload',
    'document:extract',
    'taxrule:read',
    'bank:read',
    'bank:import',
    'bank:reconcile',
    'procurement:read',
    'procurement:write',
    // An accountant enters closing stock; that is bookkeeping. Deciding the
    // period is closed is not.
    'closing:write',
    // Step J: read-only until a dedicated module role exists. See the comment
    // above the capability list.
    'crm:read',
    'inventory_ops:read',
    'hr:read',
    'project:read',
  ],
  ca_reviewer: [
    'org:read',
    'company:read',
    'registration:read',
    'member:read',
    'audit:read',
    'party:read',
    'item:read',
    'voucher:read',
    'document:read',
    'taxrule:read',
    // A CA signing off a tax rule is the whole point of the reviewer role.
    'taxrule:verify',
    'bank:read',
    'procurement:read',
    'crm:read',
    'inventory_ops:read',
    'hr:read',
    'project:read',
  ],
  viewer: [
    'org:read',
    'company:read',
    'registration:read',
    'member:read',
    'party:read',
    'item:read',
    'voucher:read',
    'document:read',
    'taxrule:read',
    'bank:read',
    'procurement:read',
    'crm:read',
    'inventory_ops:read',
    'hr:read',
    'project:read',
  ],
};

const CAPABILITY_SETS: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set(ROLE_CAPABILITIES.owner),
  accountant: new Set(ROLE_CAPABILITIES.accountant),
  ca_reviewer: new Set(ROLE_CAPABILITIES.ca_reviewer),
  viewer: new Set(ROLE_CAPABILITIES.viewer),
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITY_SETS[role].has(capability);
}

export function capabilitiesFor(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

/** Human-readable role labels for the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  accountant: 'Accountant',
  ca_reviewer: 'CA reviewer',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Full access, including people and permissions.',
  accountant: 'Maintains company data. Cannot change who has access.',
  ca_reviewer: 'Read-only, with access to the audit history.',
  viewer: 'Read-only.',
};
