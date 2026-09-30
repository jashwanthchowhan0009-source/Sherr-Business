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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: readonly Capability[] = CAPABILITIES;

/**
 * Roles are deliberately narrow. Two notes on the less obvious choices:
 *
 * - `accountant` may maintain the company profile and registrations (that is the
 *   job) but may not change who has access. Managing people is an owner action.
 * - `ca_reviewer` is read-only on data and is one of only two roles that can read
 *   the audit log. A reviewer who cannot see who changed what cannot review.
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
  ],
  ca_reviewer: ['org:read', 'company:read', 'registration:read', 'member:read', 'audit:read'],
  viewer: ['org:read', 'company:read', 'registration:read', 'member:read'],
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
