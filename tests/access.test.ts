import { describe, it, expect } from 'vitest';
import { RwsError } from 'abb-rws-client';
import {
  NO_GENERATION, NO_WRITE_ACCESS_READER, accessGroup, accessHolder, accessParts, accessRetryMs, accessSignature, accessText, answeredWord,
  clientGeneration, domainOf, lockFromMastership, lockFromWriteAccess, locksOf, modelOf, ownHold, partGood, rmmpFromPrivilege,
  unreadView,
  type AccessRead, type AccessView, type LockView, type RmmpView,
} from '../src/access.js';
import type { AccessGeneration, AccessLockName } from '../src/schema/v0.js';

const T0 = Date.parse('2026-10-05T08:00:00Z');
const T1 = T0 + 5_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Ids planted in the fake answers; none of them may ever reach a view, a group or a log word. */
const PLANTED_UID = '{0B7C3A52-6D1E-4F0A-9C55-2E81D4F7A901}';
const PLANTED_STATION = '{C4D2E8F1-77AB-4B0E-8E3A-5A1F9D20B6C3}';

const answer = (value: unknown): AccessRead => ({ answer: value });
const thrown = (error: unknown): AccessRead => ({ thrown: error });

const unread = (lock: AccessLockName): LockView => unreadView(lock === 'writeaccess' ? 'rw8' : lock === 'edit' ? 'rw7' : 'rw6')
  .locks.find(l => l.lock === lock)!;

/** A lock as a good read left it: held by a remote client, read at T0. */
const heldRemote = (lock: AccessLockName): LockView => lockFromMastership(
  unread(lock), answer({ mastership: 'remote', uid: PLANTED_UID, application: 'RobotStudio' }), T0);

describe('the locks of a generation', () => {
  it('RobotWare 6: cfg, motion, rapid; RobotWare 7: edit, motion; RobotWare 8: writeaccess; none without a generation', () => {
    expect(locksOf('rw6')).toEqual(['cfg', 'motion', 'rapid']);
    expect(locksOf('rw7')).toEqual(['edit', 'motion']);
    expect(locksOf('rw8')).toEqual(['writeaccess']);
    expect(locksOf(null)).toEqual([]);
  });

  it('the domain asked for: rapid for the RobotWare 7 edit lock too; write access has none', () => {
    expect((['cfg', 'motion', 'rapid', 'edit', 'writeaccess'] as const).map(domainOf)).toEqual(['cfg', 'motion', 'rapid', 'rapid', null]);
  });

  it('the model follows the generation', () => {
    expect([modelOf('rw6'), modelOf('rw7'), modelOf('rw8'), modelOf(null)]).toEqual(['mastership', 'mastership', 'writeaccess', null]);
  });

  it('the client generation is one of the three words, or nothing', () => {
    expect(clientGeneration({ generation: 'rw7', locks: [] })).toBe('rw7');
    for (const odd of [undefined, null, {}, { generation: null }, { generation: 'rw9' }, { generation: 7 }, 'rw7']) {
      expect(clientGeneration(odd)).toBeNull();
    }
  });

  it('a round in which every part failed is tried again after 5, 10, 20, 40, then 60 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(accessRetryMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });
});

describe('controller text', () => {
  it('is served on one line, cut to 128 characters, with anything credential-like masked', () => {
    expect(accessText('  RobotStudio \r\n 2026 ')).toBe('RobotStudio 2026');
    expect(accessText('x'.repeat(200))).toBe(`${'x'.repeat(125)}...`);
    expect(accessText('station password=hunter2')).toBe('station password=***');
    expect(accessText('')).toBeNull();
    expect(accessText('   ')).toBeNull();
    expect(accessText(7)).toBeNull();
    expect(accessText(null)).toBeNull();
  });
});

describe('mastership status -> lock (RobotWare 6 and 7)', () => {
  it('nomaster: nobody holds it', () => {
    expect(lockFromMastership(unread('cfg'), answer({ mastership: 'nomaster' }), T0)).toEqual({
      lock: 'cfg', held: false, holder: null, reported: 'nomaster', claimed: null, asOf: T0, error: null,
    });
  });

  it.each(['local', 'remote', 'internal'] as const)('%s: held, by that kind of client, with the application it reports', word => {
    const lock = lockFromMastership(unread('motion'), answer({ mastership: word, uid: PLANTED_UID, application: ' RobotStudio ' }), T0);
    expect(lock).toEqual({
      lock: 'motion', held: true, holder: { kind: word, name: null, application: 'RobotStudio', flexPendant: false }, reported: word, claimed: null,
      asOf: T0, error: null,
    });
  });

  it('the word is compared trimmed and without regard to case, and reported as it was handed over', () => {
    const lock = lockFromMastership(unread('rapid'), answer({ mastership: ' Remote ' }), T0);
    expect(lock).toMatchObject({ held: true, holder: { kind: 'remote', name: null, application: null, flexPendant: false }, reported: 'Remote' });
    expect(lockFromMastership(unread('rapid'), answer({ mastership: 'NOMASTER' }), T0)).toMatchObject({ held: false, reported: 'NOMASTER' });
  });

  it('an application that is empty, blank or no text is null', () => {
    for (const application of ['', '   ', 5, null, undefined]) {
      expect(lockFromMastership(unread('edit'), answer({ mastership: 'local', application }), T0).holder)
        .toEqual({ kind: 'local', name: null, application: null, flexPendant: null });
    }
  });

  it('a good read clears the error of the read before it', () => {
    const failed = lockFromMastership(heldRemote('cfg'), answer(null), T1);
    expect(failed.error).not.toBeNull();
    expect(lockFromMastership(failed, answer({ mastership: 'nomaster' }), T1 + 5_000)).toMatchObject({ held: false, asOf: T1 + 5_000, error: null });
  });

  // Every failed row: what the read before it gave stays, the time does not move, and nothing turns into "not held".
  const NOT_UNDERSTOOD = (lock: string) => ({ code: 'PARSE_ERROR', message: `the mastership status of ${lock} was not understood` });
  const failedRows: Array<[row: string, read: AccessRead, error: (lock: string) => object, reported: string | 'kept']> = [
    ['the client\'s own word `unknown`', answer({ mastership: 'unknown', uid: PLANTED_UID }), NOT_UNDERSTOOD, 'unknown'],
    ['a word this daemon does not know', answer({ mastership: 'exclusive' }), NOT_UNDERSTOOD, 'exclusive'],
    ['an empty word', answer({ mastership: '' }), NOT_UNDERSTOOD, 'kept'],
    ['a blank word', answer({ mastership: '   ' }), NOT_UNDERSTOOD, 'kept'],
    ['a missing field', answer({ uid: PLANTED_UID, application: 'RobotStudio' }), NOT_UNDERSTOOD, 'kept'],
    ['a field that is no text', answer({ mastership: 1 }), NOT_UNDERSTOOD, 'kept'],
    ['a result that is no object: a text', answer('nomaster'), NOT_UNDERSTOOD, 'kept'],
    ['a result that is no object: a boolean', answer(false), NOT_UNDERSTOOD, 'kept'],
    ['a result that is no object: nothing at all', answer(undefined), NOT_UNDERSTOOD, 'kept'],
    ['a list', answer(['nomaster']), NOT_UNDERSTOOD, 'kept'],
    ['null from the client', answer(null),
      lock => ({ code: 'UNKNOWN', message: `the mastership status of ${lock} could not be read` }), 'kept'],
  ];

  describe.each(failedRows)('failed read: %s', (_row, read, error, reported) => {
    it('keeps held, holder and asOf of the read before it, and sets the error', () => {
      const before = heldRemote('cfg');
      const after = lockFromMastership(before, read, T1);
      expect(after.held).toBe(true);
      expect(after.holder).toEqual({ kind: 'remote', name: null, application: 'RobotStudio', flexPendant: false });
      expect(after.asOf).toBe(T0);
      expect(after.error).toEqual(error('cfg'));
      expect(after.reported).toBe(reported === 'kept' ? 'remote' : reported);
    });

    it('as a first read it leaves held null: never "nobody holds it"', () => {
      const after = lockFromMastership(unread('motion'), read, T1);
      expect(after.held).toBeNull();
      expect(after.held).not.toBe(false);
      expect(after.holder).toBeNull();
      expect(after.asOf).toBeNull();
      expect(after.error).toEqual(error('motion'));
      expect(after.reported).toBe(reported === 'kept' ? null : reported);
    });

    it('after "nobody holds it" the lock still says so, as of the earlier read, with the error beside it', () => {
      const free = lockFromMastership(unread('rapid'), answer({ mastership: 'nomaster' }), T0);
      const after = lockFromMastership(free, read, T1);
      expect(after).toMatchObject({ held: false, holder: null, asOf: T0 });
      expect(after.error).toEqual(error('rapid'));
    });
  });

  it('a thrown read keeps everything and carries the client\'s error', () => {
    const before = heldRemote('edit');
    const after = lockFromMastership(before, thrown(new RwsError('HTTP 503 - busy', 'CONTROLLER_BUSY')), T1);
    expect(after).toEqual({ ...before, error: { code: 'CONTROLLER_BUSY', message: 'HTTP 503 - busy' } });
    expect(lockFromMastership(unread('edit'), thrown(new Error('socket hang up')), T1)).toMatchObject({
      held: null, asOf: null, error: { code: 'DAEMON_ERROR', message: 'socket hang up' },
    });
  });

  it('never reads the holder\'s user id: not into the lock, not into the word for a log line', () => {
    const reads = [
      answer({ mastership: 'remote', uid: PLANTED_UID, application: 'RobotStudio' }),
      answer({ mastership: 'unknown', uid: PLANTED_UID }),
      answer({ uid: PLANTED_UID }),
    ];
    for (const read of reads) {
      expect(JSON.stringify(lockFromMastership(unread('cfg'), read, T0))).not.toContain(PLANTED_UID);
      expect(String(answeredWord(read, 'mastership'))).not.toContain(PLANTED_UID);
    }
  });
});

describe('write-access status -> lock (RobotWare 8)', () => {
  const start = () => ({ lock: unread('writeaccess'), remoteAccessEnabled: null as boolean | null });
  /** Held by another station, remote access on, read at T0. */
  const heldByStation = () => lockFromWriteAccess(start(),
    answer({ held: true, heldByMe: false, heldById: PLANTED_STATION, heldByName: 'Cell 4 HMI', externalControlEnabled: true }), T0);

  it('held: the station is named, never identified', () => {
    const got = heldByStation();
    expect(got).toEqual({
      lock: {
        lock: 'writeaccess', held: true, holder: { kind: 'station', name: 'Cell 4 HMI', application: null, flexPendant: false }, reported: null,
        claimed: false,
        asOf: T0, error: null,
      },
      remoteAccessEnabled: true,
    });
    expect(JSON.stringify(got)).not.toContain(PLANTED_STATION);
  });

  it('not held: no holder, whatever name the answer carries', () => {
    const got = lockFromWriteAccess(start(), answer({ held: false, heldByMe: false, heldByName: 'none', externalControlEnabled: false }), T0);
    expect(got.lock).toMatchObject({ held: false, holder: null, asOf: T0, error: null });
    expect(got.remoteAccessEnabled).toBe(false);
  });

  it('a holder name that is empty, `none` or no text is null', () => {
    for (const heldByName of ['', '  ', 'none', 'None', null, undefined, 7]) {
      expect(lockFromWriteAccess(start(), answer({ held: true, heldByName }), T0).lock.holder)
        .toEqual({ kind: 'station', name: null, application: null, flexPendant: null });
    }
  });

  it('a good read without the "external control enabled" flag gives remoteAccessEnabled null, not false', () => {
    for (const externalControlEnabled of [null, undefined, 'true', 'false', 1]) {
      const got = lockFromWriteAccess(heldByStation(), answer({ held: false, heldByMe: null, heldByName: null, externalControlEnabled }), T1);
      expect(got.lock).toMatchObject({ held: false, asOf: T1, error: null });
      expect(got.remoteAccessEnabled).toBeNull();
    }
  });

  const NOT_UNDERSTOOD = { code: 'PARSE_ERROR', message: 'the write-access status was not understood' };
  const failedRows: Array<[row: string, result: unknown]> = [
    ['an empty object', {}],
    ['the texts "true" and "false"', { held: 'false', heldByMe: 'false', heldByName: '', externalControlEnabled: 'false' }],
    ['the text "true"', { held: 'true', heldByName: 'Cell 4 HMI', externalControlEnabled: 'true' }],
    ['held: null', { held: null, heldByMe: null, heldByName: null, externalControlEnabled: null }],
    ['held: a number', { held: 0, externalControlEnabled: false }],
    ['a result that is no object', 'false'],
    ['nothing at all', undefined],
    ['null', null],
  ];

  describe.each(failedRows)('failed read: %s', (_row, result) => {
    it('keeps the lock and the flag of the read before it', () => {
      const before = heldByStation();
      const after = lockFromWriteAccess(before, answer(result), T1);
      expect(after.lock).toEqual({ ...before.lock, error: NOT_UNDERSTOOD });
      expect(after.lock.held).toBe(true);
      expect(after.lock.asOf).toBe(T0);
      expect(after.remoteAccessEnabled).toBe(true);
    });

    it('as a first read nothing turns into false', () => {
      const after = lockFromWriteAccess(start(), answer(result), T1);
      expect(after.lock.held).toBeNull();
      expect(after.lock.held).not.toBe(false);
      expect(after.lock.holder).toBeNull();
      expect(after.lock.asOf).toBeNull();
      expect(after.lock.error).toEqual(NOT_UNDERSTOOD);
      expect(after.remoteAccessEnabled).toBeNull();
      expect(after.remoteAccessEnabled).not.toBe(false);
    });
  });

  it('a thrown read keeps the values and carries the client\'s error', () => {
    const before = heldByStation();
    const after = lockFromWriteAccess(before, thrown(new RwsError('the answer has no write-access status', 'PARSE_ERROR')), T1);
    expect(after).toEqual({
      lock: { ...before.lock, error: { code: 'PARSE_ERROR', message: 'the answer has no write-access status' } },
      remoteAccessEnabled: true,
    });
    expect(lockFromWriteAccess(start(), thrown(new RwsError('timeout', 'NETWORK_ERROR')), T1)).toMatchObject({
      lock: { held: null, asOf: null, error: { code: 'NETWORK_ERROR' } }, remoteAccessEnabled: null,
    });
  });
});

describe('the FlexPendant as a holder', () => {
  it('RobotWare 7 names it by the application TPU: flexPendant true, the application as the controller gave it', () => {
    const lock = lockFromMastership(unread('edit'), answer({ mastership: 'local', uid: PLANTED_UID, application: 'TPU' }), T0);
    expect(lock.holder).toEqual({ kind: 'local', name: null, application: 'TPU', flexPendant: true });
  });

  it('RobotWare 8 names it as the station FlexPendant: flexPendant true, the name as the controller gave it', () => {
    const got = lockFromWriteAccess({ lock: unread('writeaccess'), remoteAccessEnabled: null },
      answer({ held: true, heldByMe: false, heldById: PLANTED_STATION, heldByName: 'FlexPendant', externalControlEnabled: false }), T0);
    expect(got.lock.holder).toEqual({ kind: 'station', name: 'FlexPendant', application: null, flexPendant: true });
    expect(JSON.stringify(got)).not.toContain(PLANTED_STATION);
  });

  it('each name counts only in the place it was seen, trimmed and in any case; a name that only contains one does not', () => {
    const local = (application: string): boolean | null | undefined =>
      lockFromMastership(unread('motion'), answer({ mastership: 'local', application }), T0).holder?.flexPendant;
    const station = (heldByName: string): boolean | null | undefined =>
      lockFromWriteAccess({ lock: unread('writeaccess'), remoteAccessEnabled: null }, answer({ held: true, heldByName }), T0).lock.holder?.flexPendant;
    for (const named of ['TPU', ' tpu ', 'Tpu']) {
      expect(local(named), named).toBe(true);
      // A station named TPU has not been seen.
      expect(station(named), named).toBe(false);
    }
    for (const named of ['FlexPendant', 'FLEXPENDANT', ' flexpendant']) {
      expect(station(named), named).toBe(true);
      // Nor a local holder with the application FlexPendant.
      expect(local(named), named).toBe(false);
    }
    for (const named of ['RobotStudio', 'Cell 4 HMI', 'FlexPendant 2', 'My FlexPendant', 'TPU1', 'Flex Pendant']) {
      expect(local(named), named).toBe(false);
      expect(station(named), named).toBe(false);
    }
  });

  it('a remote or internal holder is never the FlexPendant, whatever application it names', () => {
    for (const mastership of ['remote', 'internal']) {
      expect(lockFromMastership(unread('rapid'), answer({ mastership, application: 'TPU' }), T0).holder)
        .toEqual({ kind: mastership, name: null, application: 'TPU', flexPendant: false });
      expect(lockFromMastership(unread('rapid'), answer({ mastership }), T0).holder?.flexPendant).toBe(false);
    }
  });

  it('a holder the controller gives no name is not known to be the FlexPendant: null, never false', () => {
    expect(lockFromMastership(unread('motion'), answer({ mastership: 'local' }), T0).holder?.flexPendant).toBeNull();
    for (const heldByName of [null, '', 'none']) {
      expect(lockFromWriteAccess({ lock: unread('writeaccess'), remoteAccessEnabled: null }, answer({ held: true, heldByName }), T0)
        .lock.holder?.flexPendant).toBeNull();
    }
  });

  it('one place builds every holder: accessHolder', () => {
    expect(accessHolder('local', null, 'TPU')).toEqual({ kind: 'local', name: null, application: 'TPU', flexPendant: true });
    expect(accessHolder('station', 'FlexPendant', null)).toEqual({ kind: 'station', name: 'FlexPendant', application: null, flexPendant: true });
    // Only the field that kind of holder carries is read: a station is named by its name, a local client by its application.
    expect(accessHolder('station', null, 'TPU').flexPendant).toBeNull();
    expect(accessHolder('local', 'FlexPendant', null).flexPendant).toBeNull();
    expect(accessHolder('remote', null, null).flexPendant).toBe(false);
    expect(accessHolder('internal', null, null).flexPendant).toBe(false);
  });
});

describe('RMMP privilege (RobotWare 6 and 7)', () => {
  const start = (): RmmpView => unreadView('rw7').rmmp;

  it.each(['none', 'pending modify', 'pending exec', 'modify', 'exec'] as const)('%s is a good read', word => {
    expect(rmmpFromPrivilege(start(), answer(word), T0)).toEqual({ supported: true, privilege: word, asOf: T0, error: null });
  });

  it('the word is compared trimmed, without regard to case or to the width of its gap', () => {
    expect(rmmpFromPrivilege(start(), answer('  Pending   Modify '), T0)).toMatchObject({ supported: true, privilege: 'pending modify' });
  });

  it.each(['rw6', 'rw7'] as const)('`unsupported` on %s settles it: not offered, no privilege, no time, no error', generation => {
    const read = rmmpFromPrivilege(unreadView(generation).rmmp, answer('none'), T0);
    expect(rmmpFromPrivilege(read, answer('unsupported'), T1)).toEqual({ supported: false, privilege: null, asOf: null, error: null });
    expect(rmmpFromPrivilege(unreadView(generation).rmmp, answer(' Unsupported '), T1)).toEqual({ supported: false, privilege: null, asOf: null, error: null });
  });

  const NOT_UNDERSTOOD = { code: 'PARSE_ERROR', message: 'the RMMP privilege was not understood' };

  it.each([['another word', 'exclusive'], ['an empty word', ''], ['no text', 3], ['null', null], ['nothing', undefined], ['an object', { privilege: 'none' }]])(
    'a failed read (%s) keeps what was there', (_row, value) => {
      const good = rmmpFromPrivilege(start(), answer('modify'), T0);
      expect(rmmpFromPrivilege(good, answer(value), T1)).toEqual({ supported: true, privilege: 'modify', asOf: T0, error: NOT_UNDERSTOOD });
      // As a first read: still not determined, never "none".
      expect(rmmpFromPrivilege(start(), answer(value), T1)).toEqual({ supported: null, privilege: null, asOf: null, error: NOT_UNDERSTOOD });
    });

  it('a thrown read keeps what was there and carries the client\'s error', () => {
    const good = rmmpFromPrivilege(start(), answer('none'), T0);
    expect(rmmpFromPrivilege(good, thrown(new RwsError('HTTP 500', 'UNKNOWN')), T1))
      .toEqual({ supported: true, privilege: 'none', asOf: T0, error: { code: 'UNKNOWN', message: 'HTTP 500' } });
  });

  it('RobotWare 8 has none: not offered from the start, with nothing read', () => {
    expect(unreadView('rw8').rmmp).toEqual({ supported: false, privilege: null, asOf: null, error: null });
  });
});

describe('the daemon\'s own hold, from the client\'s own lock state', () => {
  const own = (lock: string, state: string) => ({ generation: 'rw7', locks: [{ lock, state, count: 0, since: null }] });

  it('held is true; idle and lost are false; uncertain, or no entry, is null', () => {
    expect(ownHold(own('edit', 'held'), 'edit')).toBe(true);
    expect(ownHold(own('edit', 'idle'), 'edit')).toBe(false);
    expect(ownHold(own('edit', 'lost'), 'edit')).toBe(false);
    expect(ownHold(own('edit', 'uncertain'), 'edit')).toBeNull();
    expect(ownHold(own('edit', 'something-new'), 'edit')).toBeNull();
    expect(ownHold(own('edit', 'held'), 'motion')).toBeNull();
    expect(ownHold({ generation: null, locks: [] }, 'edit')).toBeNull();
    expect(ownHold(undefined, 'edit')).toBeNull();
    expect(ownHold({ locks: 'held' }, 'edit')).toBeNull();
  });
});

/** The client's own account, every lock of the generation in `state`. */
const client = (generation: AccessGeneration | null, state = 'idle') => ({
  generation, locks: locksOf(generation).map(lock => ({ lock, state, count: 0, since: null })),
});
const LIVE = { connected: true, quality: 'live' as const };
const POLLING = { connected: true, quality: 'polling' as const };
const STALE = { connected: true, quality: 'stale' as const };
const DOWN = { connected: false, quality: 'disconnected' as const };
/** What the client reports while not connected: it has forgotten its generation. */
const FORGOTTEN = { generation: null, locks: [] };

/** A view every part of which was read: lock i at T0 + i s, RMMP after the last lock. */
function readView(generation: AccessGeneration): AccessView {
  const view = unreadView(generation);
  if (generation === 'rw8') {
    const got = lockFromWriteAccess({ lock: view.locks[0], remoteAccessEnabled: null },
      answer({ held: true, heldByMe: false, heldById: PLANTED_STATION, heldByName: 'Cell 4 HMI', externalControlEnabled: true }), T0);
    return { ...view, locks: [got.lock], remoteAccessEnabled: got.remoteAccessEnabled };
  }
  return {
    ...view,
    locks: view.locks.map((l, i) => lockFromMastership(l, answer(l.lock === 'motion'
      ? { mastership: 'local', uid: PLANTED_UID, application: 'TPU' }
      : { mastership: 'nomaster' }), T0 + i * 1_000)),
    rmmp: rmmpFromPrivilege(view.rmmp, answer('none'), T0 + view.locks.length * 1_000),
  };
}

describe('the access group', () => {
  it('RobotWare 6: three mastership locks and RMMP, read by polling', () => {
    const g = accessGroup(readView('rw6'), LIVE, client('rw6'), false, true);
    expect(g).toEqual({
      generation: 'rw6', model: 'mastership',
      locks: [
        { lock: 'cfg', held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: iso(T0), error: null },
        { lock: 'motion', held: true, holder: { kind: 'local', name: null, application: 'TPU', flexPendant: true }, heldByDaemon: false,
          reported: 'local', asOf: iso(T0 + 1_000), error: null },
        { lock: 'rapid', held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: iso(T0 + 2_000), error: null },
      ],
      remoteAccessEnabled: null,
      rmmp: { supported: true, privilege: 'none', asOf: iso(T0 + 3_000), error: null },
      via: 'poll', problem: null, asOf: iso(T0),
    });
  });

  it('RobotWare 7: edit and motion', () => {
    const g = accessGroup(readView('rw7'), POLLING, client('rw7'), false, true);
    expect(g).toMatchObject({ generation: 'rw7', model: 'mastership', via: 'poll', problem: null, asOf: iso(T0) });
    expect(g.locks.map(l => [l.lock, l.held])).toEqual([['edit', false], ['motion', true]]);
  });

  it('RobotWare 8 with a client that reads the status: one lock, the flag, no RMMP', () => {
    const g = accessGroup(readView('rw8'), LIVE, client('rw8'), true, true);
    expect(g).toEqual({
      generation: 'rw8', model: 'writeaccess',
      locks: [{
        lock: 'writeaccess', held: true, holder: { kind: 'station', name: 'Cell 4 HMI', application: null, flexPendant: false }, heldByDaemon: false,
        reported: null, asOf: iso(T0), error: null,
      }],
      remoteAccessEnabled: true,
      rmmp: { supported: false, privilege: null, asOf: null, error: null },
      via: 'poll', problem: null,
      asOf: iso(T0),   // RMMP is no part on RobotWare 8: the lock alone dates the group
    });
  });

  it('RobotWare 8 with a client that lacks the read: a problem, nothing read, via null', () => {
    const g = accessGroup(null, LIVE, client('rw8'), false, true);
    expect(g).toEqual({
      generation: 'rw8', model: 'writeaccess',
      locks: [{ lock: 'writeaccess', held: null, holder: null, heldByDaemon: false, reported: null, asOf: null, error: null }],
      remoteAccessEnabled: null,
      rmmp: { supported: false, privilege: null, asOf: null, error: null },
      via: null, problem: NO_WRITE_ACCESS_READER, asOf: null,
    });
    // The text names what this release does, not a gap of the client's.
    expect(NO_WRITE_ACCESS_READER).toBe('this abb-rws-client cannot read the write-access status');
  });

  it('a healthy link without a generation: a problem, no locks, via null', () => {
    for (const reported of [client(null), undefined, {}]) {
      const g = accessGroup(null, LIVE, reported, true, true);
      expect(g).toEqual({
        generation: null, model: null, locks: [], remoteAccessEnabled: null,
        rmmp: { supported: null, privilege: null, asOf: null, error: null }, via: null, problem: NO_GENERATION, asOf: null,
      });
    }
    expect(NO_GENERATION).toBe('the controller did not report a RobotWare version the client could use');
  });

  it('a link without a generation that is not healthy has no problem to state: nothing is known yet', () => {
    expect(accessGroup(null, STALE, client(null), true, true)).toMatchObject({ generation: null, via: null, problem: null });
    expect(accessGroup(null, DOWN, FORGOTTEN, true, true)).toMatchObject({ generation: null, via: null, problem: null });
  });

  it('unread on a usable link: every lock without a value, via `poll` because the reads are on their way', () => {
    for (const view of [null, unreadView('rw7')]) {
      const g = accessGroup(view, LIVE, client('rw7'), false, true);
      expect(g.via).toBe('poll');
      expect(g.asOf).toBeNull();
      expect(g.locks).toEqual([
        { lock: 'edit', held: null, holder: null, heldByDaemon: false, reported: null, asOf: null, error: null },
        { lock: 'motion', held: null, holder: null, heldByDaemon: false, reported: null, asOf: null, error: null },
      ]);
      expect(g.rmmp).toEqual({ supported: null, privilege: null, asOf: null, error: null });
    }
  });

  it('via is `poll` only with a readable part: not while stale, down, without a generation, or with a problem', () => {
    expect(accessGroup(readView('rw7'), LIVE, client('rw7'), false, true).via).toBe('poll');
    expect(accessGroup(readView('rw7'), POLLING, client('rw7'), false, true).via).toBe('poll');
    expect(accessGroup(readView('rw7'), STALE, client('rw7'), false, true).via).toBeNull();
    expect(accessGroup(readView('rw7'), DOWN, FORGOTTEN, false, true).via).toBeNull();
    expect(accessGroup(readView('rw7'), { connected: false, quality: 'live' }, FORGOTTEN, false, true).via).toBeNull();
    expect(accessGroup(null, LIVE, client(null), false, true).via).toBeNull();
    expect(accessGroup(null, LIVE, client('rw8'), false, true).via).toBeNull();
  });

  it('a link on the wrong controller carries nothing, whatever was read', () => {
    expect(accessGroup(readView('rw6'), LIVE, client('rw6'), true, false)).toEqual({
      generation: null, model: null, locks: [], remoteAccessEnabled: null,
      rmmp: { supported: null, privilege: null, asOf: null, error: null }, via: null, problem: null, asOf: null,
    });
  });

  it('a link that is down keeps the values, their times and the generation they were read under', () => {
    const up = accessGroup(readView('rw6'), LIVE, client('rw6'), false, true);
    const down = accessGroup(readView('rw6'), DOWN, FORGOTTEN, false, true);
    expect(down.generation).toBe('rw6');
    expect(down.model).toBe('mastership');
    expect(down.via).toBeNull();
    expect(down.problem).toBeNull();
    expect(down.asOf).toBe(up.asOf);
    expect(down.rmmp).toEqual(up.rmmp);
    expect(down.locks.map(({ heldByDaemon: _own, ...rest }) => rest)).toEqual(up.locks.map(({ heldByDaemon: _own, ...rest }) => rest));
    // The client has no record of its own holds without a session.
    expect(down.locks.map(l => l.heldByDaemon)).toEqual([null, null, null]);
  });

  it('a stale link keeps them too, under the generation the client still reports', () => {
    const g = accessGroup(readView('rw7'), STALE, client('rw7'), false, true);
    expect(g).toMatchObject({ generation: 'rw7', via: null, asOf: iso(T0) });
    expect(g.locks[1]).toMatchObject({ held: true, holder: { kind: 'local' }, heldByDaemon: false });
  });

  it('values read under another generation are not shown under this one', () => {
    const g = accessGroup(readView('rw6'), LIVE, client('rw7'), false, true);
    expect(g.generation).toBe('rw7');
    expect(g.locks.map(l => [l.lock, l.held, l.asOf])).toEqual([['edit', null, null], ['motion', null, null]]);
    expect(accessGroup(readView('rw6'), LIVE, client(null), false, true).locks).toEqual([]);
  });

  it('asOf is the oldest part, and null while any part has none', () => {
    const view = readView('rw6');
    expect(accessGroup(view, LIVE, client('rw6'), false, true).asOf).toBe(iso(T0));
    const later: AccessView = { ...view, locks: view.locks.map(l => ({ ...l, asOf: T1 })), rmmp: { ...view.rmmp, asOf: T0 + 500 } };
    expect(accessGroup(later, LIVE, client('rw6'), false, true).asOf).toBe(iso(T0 + 500));
    const oneUnread: AccessView = { ...view, locks: view.locks.map((l, i) => (i === 2 ? { ...l, held: null, asOf: null } : l)) };
    expect(accessGroup(oneUnread, LIVE, client('rw6'), false, true).asOf).toBeNull();
    const rmmpUnread: AccessView = { ...view, rmmp: unreadView('rw6').rmmp };
    expect(accessGroup(rmmpUnread, LIVE, client('rw6'), false, true).asOf).toBeNull();
  });

  it('RMMP is left out of asOf once the controller does not offer it', () => {
    const view = readView('rw6');
    const notOffered: AccessView = { ...view, rmmp: rmmpFromPrivilege(view.rmmp, answer('unsupported'), T1) };
    const g = accessGroup(notOffered, LIVE, client('rw6'), false, true);
    expect(g.rmmp).toEqual({ supported: false, privilege: null, asOf: null, error: null });
    expect(g.asOf).toBe(iso(T0));
    expect(accessParts(g).map(p => p.name)).toEqual(['cfg', 'motion', 'rapid']);
  });
});

describe('heldByDaemon', () => {
  it.each(['rw6', 'rw7', 'rw8'] as const)('%s: from the client\'s own lock state, never from the controller\'s status', generation => {
    const view = readView(generation);
    const of = (state: string) => accessGroup(view, LIVE, client(generation, state), true, true).locks.map(l => l.heldByDaemon);
    const n = locksOf(generation).length;
    expect(of('held')).toEqual(Array(n).fill(true));
    expect(of('idle')).toEqual(Array(n).fill(false));
    expect(of('lost')).toEqual(Array(n).fill(false));
    expect(of('uncertain')).toEqual(Array(n).fill(null));
    expect(accessGroup(view, LIVE, { generation, locks: [] }, true, true).locks.map(l => l.heldByDaemon)).toEqual(Array(n).fill(null));
  });

  it('a lock the controller reports held by a remote client is not the daemon\'s for that', () => {
    const view = { ...unreadView('rw7'), locks: [heldRemote('edit'), heldRemote('motion')] };
    expect(accessGroup(view, LIVE, client('rw7'), false, true).locks.map(l => l.heldByDaemon)).toEqual([false, false]);
  });

  it('RobotWare 8: the controller naming this client\'s station while the client\'s own state is idle gives null, never true', () => {
    const got = lockFromWriteAccess({ lock: unread('writeaccess'), remoteAccessEnabled: null },
      answer({ held: true, heldByMe: true, heldByName: 'this-station', externalControlEnabled: true }), T0);
    const view: AccessView = { ...unreadView('rw8'), locks: [got.lock], remoteAccessEnabled: got.remoteAccessEnabled };
    for (const state of ['idle', 'lost', 'uncertain']) {
      const own = accessGroup(view, LIVE, client('rw8', state), true, true).locks[0].heldByDaemon;
      expect(own).toBeNull();
      expect(own).not.toBe(true);
    }
    expect(accessGroup(view, LIVE, { generation: 'rw8', locks: [] }, true, true).locks[0].heldByDaemon).toBeNull();
    // Only the client's own record makes it true.
    expect(accessGroup(view, LIVE, client('rw8', 'held'), true, true).locks[0].heldByDaemon).toBe(true);
  });

  it('RobotWare 8: `heldByMe` false or unknown changes nothing', () => {
    for (const heldByMe of [false, null, 'true']) {
      const got = lockFromWriteAccess({ lock: unread('writeaccess'), remoteAccessEnabled: null }, answer({ held: true, heldByMe }), T0);
      const view: AccessView = { ...unreadView('rw8'), locks: [got.lock] };
      expect(accessGroup(view, LIVE, client('rw8', 'idle'), true, true).locks[0].heldByDaemon).toBe(false);
    }
  });
});

describe('parts, and what counts as good', () => {
  it('a lock is good with a value and no error; RMMP when offered, read and not failing', () => {
    const g = accessGroup(readView('rw7'), LIVE, client('rw7'), false, true);
    expect(g.locks.every(partGood)).toBe(true);
    expect(partGood(g.rmmp)).toBe(true);
    expect(partGood({ ...g.locks[0], held: null })).toBe(false);
    expect(partGood({ ...g.locks[0], error: { code: 'UNKNOWN', message: 'x' } })).toBe(false);
    expect(partGood({ ...g.rmmp, error: { code: 'UNKNOWN', message: 'x' } })).toBe(false);
    expect(partGood({ supported: null, privilege: null, asOf: null, error: null })).toBe(false);
    expect(partGood({ supported: false, privilege: null, asOf: null, error: null })).toBe(false);
    expect(accessParts(g)).toEqual([
      { name: 'edit', asOf: iso(T0), error: null, good: true },
      { name: 'motion', asOf: iso(T0 + 1_000), error: null, good: true },
      { name: 'RMMP', asOf: iso(T0 + 2_000), error: null, good: true },
    ]);
  });
});

describe('the signature', () => {
  it('ignores every asOf moving on, and sees one appear', () => {
    const view = readView('rw6');
    const a = accessGroup(view, LIVE, client('rw6'), false, true);
    const moved: AccessView = {
      ...view, locks: view.locks.map(l => ({ ...l, asOf: l.asOf! + 5_000 })), rmmp: { ...view.rmmp, asOf: view.rmmp.asOf! + 5_000 },
    };
    const b = accessGroup(moved, LIVE, client('rw6'), false, true);
    expect(b).not.toEqual(a);
    expect(accessSignature(b)).toBe(accessSignature(a));
    expect(accessSignature(accessGroup(unreadView('rw6'), LIVE, client('rw6'), false, true))).not.toBe(accessSignature(a));
  });

  it('changes with a holder, an error, the flag and via', () => {
    const base = accessGroup(readView('rw7'), LIVE, client('rw7'), false, true);
    const sig = accessSignature(base);
    expect(accessSignature({ ...base, via: null })).not.toBe(sig);
    expect(accessSignature({ ...base, remoteAccessEnabled: true })).not.toBe(sig);
    expect(accessSignature({ ...base, locks: [{ ...base.locks[0], held: true }, base.locks[1]] })).not.toBe(sig);
    expect(accessSignature({ ...base, locks: [{ ...base.locks[0], error: { code: 'UNKNOWN', message: 'x' } }, base.locks[1]] })).not.toBe(sig);
  });
});

describe('ids never reach the group', () => {
  it('a user id planted in every mastership answer and a station id planted in the write-access answer are absent', () => {
    for (const generation of ['rw6', 'rw7', 'rw8'] as const) {
      const text = JSON.stringify(accessGroup(readView(generation), LIVE, client(generation), true, true));
      expect(text).not.toContain(PLANTED_UID);
      expect(text).not.toContain(PLANTED_STATION);
      expect(text).not.toMatch(/uid|heldById/i);
    }
    // Also not after reads that were not understood.
    const view = readView('rw6');
    const failed: AccessView = {
      ...view,
      locks: view.locks.map(l => lockFromMastership(l, answer({ mastership: 'unknown', uid: PLANTED_UID, application: PLANTED_UID.slice(1, 9) }), T1)),
    };
    expect(JSON.stringify(accessGroup(failed, LIVE, client('rw6'), false, true))).not.toContain(PLANTED_UID);
    const odd = lockFromWriteAccess({ lock: unread('writeaccess'), remoteAccessEnabled: null },
      answer({ held: 'true', heldById: PLANTED_STATION }), T1);
    expect(JSON.stringify(accessGroup({ ...unreadView('rw8'), locks: [odd.lock] }, LIVE, client('rw8'), true, true))).not.toContain(PLANTED_STATION);
  });

  it('an id inside the text of a thrown read is masked, in the message and in what the controller answered', () => {
    const bare = PLANTED_UID.slice(1, -1);
    // Forms the key rules of the usual masking do not know: no key, a header-like name, a sentence.
    const texts = [`HTTP 500 - uid ${PLANTED_UID}`, `held-by-control-station-Id: ${PLANTED_STATION}`, `owned by ${bare} since yesterday`];
    for (const text of texts) {
      const error = Object.assign(new RwsError(text, 'UNKNOWN'), { httpStatus: 500, controllerMsg: text });
      const lock = lockFromMastership(heldRemote('edit'), thrown(error), T1);
      const station = lockFromWriteAccess({ lock: unread('writeaccess'), remoteAccessEnabled: null }, thrown(error), T1);
      const rmmp = rmmpFromPrivilege(unreadView('rw7').rmmp, thrown(error), T1);
      for (const served of [lock.error, station.lock.error, rmmp.error]) {
        const json = JSON.stringify(served);
        expect(json, text).not.toContain(bare);
        expect(json, text).not.toContain(bare.toLowerCase());
        expect(served!.message, text).toContain('***');
        expect(served!.controller?.message, text).toContain('***');
        expect(served!.code).toBe('UNKNOWN');
      }
      // What was read before stays as it was.
      expect(lock).toMatchObject({ held: true, holder: { kind: 'remote', application: 'RobotStudio' }, asOf: T0 });
    }
    // A text without one is served as the client gave it.
    const plain = lockFromMastership(unread('cfg'), thrown(new RwsError('HTTP 503 - busy', 'CONTROLLER_BUSY')), T1);
    expect(plain.error).toEqual({ code: 'CONTROLLER_BUSY', message: 'HTTP 503 - busy' });
  });
});
