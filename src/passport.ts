import { createAdapter } from 'abb-rws-client';
import type { IRWSAdapter } from 'abb-rws-client';
import { toIdentity, type IdentityFields } from './identity.js';
import type { Generation, RobotWareVersion } from './schema/v0.js';

export interface PassportTarget {
  host: string;
  port: number;
  useHttps: boolean;
  username: string;
  password: string;
}

export type VerdictLevel = 'supported' | 'untested' | 'unsupported';

export interface Verdict {
  level: VerdictLevel;
  notes: string[];
}

/**
 * Everything worth knowing about a controller before adding it. Licences and
 * products are passed through as the controller reported them: their shape
 * differs by generation and the client does not normalise it.
 */
export interface Passport {
  target: { host: string; port: number; useHttps: boolean };
  identity: IdentityFields;
  robotType: string | null;
  controllerOptions: string[];
  licencesRaw: Array<Record<string, string>>;
  productsRaw: Array<Record<string, string>>;
  verdict: Verdict;
}

/**
 * RobotWare major.minor versions this project has live evidence for (virtual
 * controllers). 8.2: the daemon ran end to end on an RW 8.2.1+1023 virtual
 * controller (2026-09-29, and again 2026-10-01).
 */
export const TESTED_VERSIONS = ['6.16', '7.21', '8.1', '8.2'] as const;

/** How well this project supports a controller, and what an engineer should know. */
export function verdictFor(rw: RobotWareVersion, virtual: boolean | null): Verdict {
  const notes: string[] = [];
  let level: VerdictLevel;

  if (rw.major === null || rw.major < 6 || rw.major > 8) {
    level = 'unsupported';
    notes.push(`RobotWare ${rw.raw ?? 'version unknown'} is outside the supported range (6, 7, 8).`);
  } else if (TESTED_VERSIONS.includes(`${rw.major}.${rw.minor}` as typeof TESTED_VERSIONS[number])) {
    level = 'supported';
  } else {
    level = 'untested';
    notes.push(`RobotWare ${rw.major}.${rw.minor} has not been tested; tested versions are ${TESTED_VERSIONS.join(', ')}.`);
  }

  // A virtual controller needs no note: forward and inverse kinematics solve
  // there too (live-verified 2026-09-30 on RW 6.16.03, 7.21.4 and 8.2.1). The
  // earlier "unavailable without the PC Interface option" came from the
  // client sending the wrong units, not from the controller.
  if (virtual === false) {
    notes.push('Real controller: support has been verified on virtual controllers only so far.');
  }
  if (rw.major === 8) {
    notes.push('RobotWare 8: a tool that writes must register as a control station and be given write access; '
      + 'the vendor\'s manuals tie that to remote access being allowed at the FlexPendant. This daemon only reads.');
  }
  return { level, notes };
}

/**
 * Connect once, read what identifies the controller, disconnect. One session,
 * always logged out, so a setup screen cannot leak sessions against the
 * controller's session limit.
 */
export async function readPassport(t: PassportTarget): Promise<Passport> {
  let a: IRWSAdapter | null = null;
  try {
    a = await createAdapter({ host: t.host, port: t.port, https: t.useHttps, username: t.username, password: t.password });
    await a.connect();
    const generation: Generation = t.useHttps ? 'rws2' : 'rws1';
    const [id, sys, options, licences, products, robotType] = await Promise.all([
      a.getControllerIdentity(),
      a.getSystemInfo(),
      a.listControllerOptions?.().catch(() => []) ?? [],
      a.getLicenseInfo?.().catch(() => ({ entries: [] })) ?? { entries: [] },
      a.listProducts?.().catch(() => []) ?? [],
      a.getRobotType?.().catch(() => null) ?? null,
    ]);
    const identity = toIdentity(id, sys, generation)!;
    return {
      target: { host: t.host, port: t.port, useHttps: t.useHttps },
      identity,
      robotType: robotType?.type ?? null,
      controllerOptions: options.map(o => o.name),
      licencesRaw: licences.entries,
      productsRaw: products,
      verdict: verdictFor(identity.robotWare, identity.virtual),
    };
  } finally {
    await a?.disconnect().catch(() => {});
  }
}
