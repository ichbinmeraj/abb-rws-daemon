import { describe, it, expect } from 'vitest';
import { parseRobotWare, toIdentity } from '../src/identity.js';
import { verdictFor } from '../src/passport.js';

// Values as the three virtual controllers reported them on 2026-09-23.
const RW8 = {
  id: { name: 'CRB1910_10_1520', id: '', type: 'VIRTUAL_CONTROLLER', mac: '' },
  sys: { name: 'CRB1910_10_1520', rwVersion: '8.1.1+614', sysid: '{DDDEA751-93CE-4DAC-8D85-55725137AF66}',
    startTime: '2026-09-23 T 21:54:12', options: ['RobotControl Base', 'English'] },
};
const RW6 = {
  id: { name: 'VC-HOST', id: '', type: 'Virtual Controller', mac: '' },
  sys: { name: 'IRB1600_6_145', rwVersion: '6.16.3007', sysid: '{F2E08F07-3F27-4DE5-82CC-74A72537F492}',
    startTime: '2026-09-23 T 21:55:05', options: ['RobotWare Base'] },
};

describe('parseRobotWare', () => {
  it('reads major and minor from both version styles', () => {
    expect(parseRobotWare('8.1.1+614', 'rws2')).toEqual({ raw: '8.1.1+614', major: 8, minor: 1, generation: 'rws2' });
    expect(parseRobotWare('6.16.3007', 'rws1')).toMatchObject({ major: 6, minor: 16 });
  });

  it('keeps an unparseable version as raw with null numbers', () => {
    expect(parseRobotWare('garbage', null)).toEqual({ raw: 'garbage', major: null, minor: null, generation: null });
    expect(parseRobotWare(undefined, null).raw).toBeNull();
  });
});

describe('toIdentity', () => {
  it('maps an RW8 virtual controller, turning empty strings into null', () => {
    const g = toIdentity(RW8.id, RW8.sys, 'rws2')!;
    expect(g.controllerName).toBe('CRB1910_10_1520');
    expect(g.controllerId).toBeNull();
    expect(g.mac).toBeNull();
    expect(g.virtual).toBe(true);
    expect(g.robotWare.major).toBe(8);
    expect(g.startTime).toBe('2026-09-23 T 21:54:12');   // passed through, not reinterpreted
  });

  it('recognises the RW6 spelling of a virtual controller too', () => {
    const g = toIdentity(RW6.id, RW6.sys, 'rws1')!;
    expect(g.virtual).toBe(true);
    // On RW6 the controller name is the host PC's name, not the system name - both are kept.
    expect(g.controllerName).toBe('VC-HOST');
    expect(g.systemName).toBe('IRB1600_6_145');
  });

  it('is null before anything has been read', () => {
    expect(toIdentity(null, null, null)).toBeNull();
  });

  it('leaves `virtual` null for a type it does not recognise', () => {
    expect(toIdentity({ ...RW8.id, type: 'SOMETHING_NEW' }, RW8.sys, 'rws2')!.virtual).toBeNull();
  });
});

describe('verdictFor', () => {
  it('supports a tested version and does not claim kinematics are missing on a VC', () => {
    // Forward and inverse kinematics solve on virtual controllers
    // (live-verified 2026-09-30 on RW 6.16.03, 7.21.4 and 8.2.1), so a VC gets
    // no "unavailable" note; the old note came from the client's unit bug.
    const v = verdictFor(parseRobotWare('7.21.0+229', 'rws2'), true);
    expect(v.level).toBe('supported');
    expect(v.notes.join(' ')).not.toMatch(/kinematics/);
  });

  it('supports RobotWare 8.2, run end to end on an 8.2.1+1023 virtual controller', () => {
    const v = verdictFor(parseRobotWare('8.2.1+1023', 'rws2'), true);
    expect(v.level).toBe('supported');
    expect(v.notes.join(' ')).not.toMatch(/has not been tested/);
  });

  it('marks an untested minor as untested, not unsupported', () => {
    expect(verdictFor(parseRobotWare('7.18.0', 'rws2'), true).level).toBe('untested');
  });

  it('refuses versions outside 6-8, and an unknown version', () => {
    expect(verdictFor(parseRobotWare('5.15.0', 'rws1'), false).level).toBe('unsupported');
    expect(verdictFor(parseRobotWare(null, null), null).level).toBe('unsupported');
  });

  it('flags a real controller as verified on VCs only, and RW8 write access', () => {
    expect(verdictFor(parseRobotWare('8.1.1', 'rws2'), false).notes.join(' ')).toMatch(/virtual controllers only/);
    expect(verdictFor(parseRobotWare('8.1.1', 'rws2'), true).notes).toContain(
      'RobotWare 8: a tool that writes must register as a control station and be given write access; '
      + 'the vendor\'s manuals tie that to remote access being allowed at the FlexPendant. This daemon only reads.');
  });

  it('says nothing about write access on RobotWare 6 and 7', () => {
    for (const version of ['6.16.3007', '7.21.0+229']) {
      expect(verdictFor(parseRobotWare(version, 'rws2'), true).notes.join(' ')).not.toMatch(/control station|write access/i);
    }
  });
});
