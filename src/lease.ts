import { randomUUID } from 'node:crypto';
import { NEW_LEASE, WATCH_LEASES_MAX } from './schema/v0.js';

/**
 * Watch leases per consumer (schema 0.6): which lease a motion or I/O watch
 * request renews. The contract is described at `NEW_LEASE` in the schema.
 */

/** The key of the one lease every request without a lease id renews. Never a lease id (those are at least one character). */
export const ANONYMOUS_LEASE = '';

/** A lease id as a request may carry it: `NEW_LEASE`, or an id a grant returned (a UUID). */
export const LEASE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The lease a request renews: the anonymous one without an id, a newly minted
 * id for `NEW_LEASE`, the named one otherwise.
 */
export function leaseKeyFor(leaseId: string | undefined): string {
  if (leaseId === undefined) { return ANONYMOUS_LEASE; }
  return leaseId === NEW_LEASE ? randomUUID() : leaseId;
}

/**
 * Whether a controller already holds as many leases with an id as it may, so
 * that the lease of `key` cannot be opened. Renewing a lease it holds, and
 * the anonymous lease, are never refused. `leases` holds only leases still
 * running.
 */
export function leaseLimitReached(leases: ReadonlyMap<string, unknown>, key: string): boolean {
  if (key === ANONYMOUS_LEASE || leases.has(key)) { return false; }
  let withId = 0;
  for (const k of leases.keys()) { if (k !== ANONYMOUS_LEASE) { withId++; } }
  return withId >= WATCH_LEASES_MAX;
}

/** What a grant answers about its lease: its id, or nothing for the anonymous lease. */
export function leaseIdField(key: string): { leaseId?: string } {
  return key === ANONYMOUS_LEASE ? {} : { leaseId: key };
}
