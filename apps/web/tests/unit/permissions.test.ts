import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, ROLE_CAPABILITIES, can, capabilitiesFor,
} from '../../src/lib/auth/permissions';
import { ROLES } from '../../src/lib/db/schema';

describe('role capability matrix', () => {
  it('defines capabilities for every role', () => {
    for (const role of ROLES) expect(ROLE_CAPABILITIES[role]).toBeDefined();
  });

  it('grants no capability that is not declared', () => {
    for (const role of ROLES) {
      for (const capability of capabilitiesFor(role)) {
        expect(CAPABILITIES).toContain(capability);
      }
    }
  });

  it('gives the owner everything', () => {
    for (const capability of CAPABILITIES) expect(can('owner', capability)).toBe(true);
  });

  it.each(['ca_reviewer', 'viewer'] as const)('%s cannot mutate anything', (role) => {
    const mutations = CAPABILITIES.filter(
      (c) => c.endsWith(':update') || c.endsWith(':write') || c.endsWith(':invite')
        || c.endsWith(':remove') || c.endsWith(':revoke') || c.endsWith(':update_role'),
    );
    for (const capability of mutations) {
      expect(can(role, capability), `${role} must not hold ${capability}`).toBe(false);
    }
  });

  it('lets only the owner manage people', () => {
    for (const capability of ['member:invite', 'member:update_role', 'member:remove'] as const) {
      expect(can('owner', capability)).toBe(true);
      expect(can('accountant', capability)).toBe(false);
      expect(can('ca_reviewer', capability)).toBe(false);
      expect(can('viewer', capability)).toBe(false);
    }
  });

  it('restricts the audit log to the owner and the CA reviewer', () => {
    expect(can('owner', 'audit:read')).toBe(true);
    expect(can('ca_reviewer', 'audit:read')).toBe(true);
    expect(can('accountant', 'audit:read')).toBe(false);
    expect(can('viewer', 'audit:read')).toBe(false);
  });

  it('lets the accountant maintain company data but not access', () => {
    expect(can('accountant', 'company:update')).toBe(true);
    expect(can('accountant', 'registration:write')).toBe(true);
    expect(can('accountant', 'member:update_role')).toBe(false);
  });

  it('gives every role the ability to read the company it belongs to', () => {
    for (const role of ROLES) expect(can(role, 'company:read')).toBe(true);
  });
});
