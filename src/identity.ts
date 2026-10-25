import type { ControllerIdentity, SystemInfo } from 'abb-rws-client';
import type { Generation, IdentityGroup, RobotWareVersion } from './schema/v0.js';

/** "7.21.0+229" -> 7, 21. "6.16.3007" -> 6, 16. Anything unparseable -> nulls. */
export function parseRobotWare(raw: string | null | undefined, generation: Generation | null): RobotWareVersion {
  const m = raw?.match(/^(\d+)\.(\d+)/);
  return {
    raw: raw ?? null,
    major: m ? Number(m[1]) : null,
    minor: m ? Number(m[2]) : null,
    generation,
  };
}

/** Empty strings from the controller mean "not reported" in the snapshot. */
const orNull = (s: string | null | undefined): string | null => (s ? s : null);

function isVirtual(type: string | null): boolean | null {
  if (!type) { return null; }
  const t = type.toLowerCase().replace(/[\s_]+/g, ' ');
  if (t === 'virtual controller') { return true; }
  if (t === 'real controller') { return false; }
  return null;
}

/** Identity as read, before the fleet stamps when it was read. */
export type IdentityFields = Omit<IdentityGroup, 'asOf'>;

/** Build the identity group from what the client read. null until anything is known. */
export function toIdentity(
  identity: ControllerIdentity | null,
  system: SystemInfo | null,
  generation: Generation | null,
): IdentityFields | null {
  if (!identity && !system) { return null; }
  const type = orNull(identity?.type);
  return {
    controllerName: orNull(identity?.name),
    controllerId: orNull(identity?.id),
    controllerType: type,
    virtual: isVirtual(type),
    mac: orNull(identity?.mac),
    systemName: orNull(system?.name),
    sysId: orNull(system?.sysid),
    startTime: orNull(system?.startTime),
    robotWare: parseRobotWare(system?.rwVersion, generation),
    options: system?.options ?? [],
  };
}
