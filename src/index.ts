export { httpStatusFor, errorBody, groupError, controllerAnswerOf, refusalOf, redactSecrets } from './errorMap.js';
export {
  isLocalHostHeader, isAllowedHostHeader, hostAllowlist, isAllowedOrigin, canonicalOrigin, originAllowlist, DEFAULT_PANEL_ORIGINS,
} from './localGuard.js';
export { SocketHub, CLOSE_GOING_AWAY, type SocketLike } from './wsHub.js';
export { SnapshotStream, registerStreamRoute, type StreamSource } from './stream.js';
export {
  createServer, DEFAULT_PORT, BIND_HOST, HEALTH_PATH, DAEMON_VERSION, NO_RECORDING, type ServerOptions, type HealthStatus,
} from './server.js';
export {
  loadOrCreateToken, defaultTokenPath, userConfigDir, newToken, tokenMatcher, presentedToken, tokenRefusal, selectStreamProtocol,
  TOKEN_PATTERN, TOKEN_FILE_NAME, type TokenFileOptions, type PresentedToken, type TokenRefusal,
} from './token.js';
export {
  registerControllerRoutes, registerAdminRoutes, SHUTDOWN_PATH, type RouteDeps, type AdminDeps, type SavedDiscovery,
} from './routes.js';
export {
  ControllerFleet, summarize, identityCheck, reconnectDelayMs, DISCONNECT_ALL_WAIT_MS,
  eventsTrusted, eventsLinkReady, eventsPeriod, NO_CLOCK_READER,
  type FleetLike, type Log, type ManagerView, type Timing, type ControllerLogout, type LogoutOutcome,
} from './fleet.js';
export {
  accessGroup, accessHolder, accessParts, accessRetryMs, accessSignature, accessText, answeredWord, clientGeneration, domainOf,
  lockFromMastership, lockFromWriteAccess, locksOf, modelOf, ownHold, partGood, rmmpFromPrivilege, unreadView,
  NO_WRITE_ACCESS_READER, NO_GENERATION, ACCESS_TEXT_MAX,
  type AccessView, type LockView, type RmmpView, type AccessRead, type AccessPart,
} from './access.js';
export { capabilitiesGroup, clientFacts, CAPABILITY_IDS, type ClientFacts } from './capabilities.js';
export { freshnessGroup, FRESH_GROUPS, WITHHELD_REASON } from './freshness.js';
export {
  EventFeed, eventsGroup, eventsSignature, parseControllerTime, clockOffsetMs, compareSeqnum, eventText,
  eventsReadIntervalMs, eventsReadRequests, eventsRetryMs,
  EVENTS_POLL_MS, EVENTS_RECHECK_MS, EVENTS_RWS2_PAGE, RWS1_SEQNUM_SPAN, EVENT_KEYS_MIN, EVENT_KEYS_MAX,
  EVENT_ARGS_MAX, EVENT_ARG_TEXT_MAX,
  type EventsView, type TakeContext,
} from './events.js';
export {
  DaemonStop, onStopSignals, stopSignals, logLogouts, STOP_RESERVE_MS, STOP_RECORDING_MS, type StopParts, type StopOptions,
} from './stop.js';
export {
  MOTION_LEASE_MS, MOTION_HZ, MOTION_HZ_POLLING, POSE_EVERY_TICKS, motionGroup, motionJoints, motionTargetHz,
  measuredHz, poseFrom, unitKind, unitMetaFrom, type MotionView, type UnitMeta,
} from './motion.js';
export {
  loadConfig, loadConfigFile, saveConfig, saveDiscoverySettings, validateDiscovery, emptyDiscoverySettings,
  writeOwnerOnly, idFromName, configAccessProblem, ownerOnlyProblem, daclOthers, modeProblem, ownerOnlyAclArgs,
  createOwnerOnlyAppend, ownerOnlyDirProblem, makeOwnerOnlyDir,
  DISCOVERY_MANUAL_MAX, DISCOVERY_RANGES_MAX, DISCOVERY_PORTS_MAX, DISCOVERY_RANGE_TEXT_MAX,
  type ConfigAccessOptions, type OwnerOnlyWriteOptions, type OwnerOnlyFsOptions, type OwnerOnlyHandle,
  type ControllerConfig, type ConfigContents, type DiscoverySettings, type SavedDiscoveryTarget,
} from './config.js';
export {
  discover, discoveryOptions, toDiscoveryEntry, toDiscoveryAnswer, configuredMatcher, mergeDiscovery, RANGE_SCAN_INTERVAL_MS,
  type DiscoveryEntry, type DiscoverySource, type DiscoverRequest, type DiscoveryTarget, type DiscoveryAnswer,
} from './discovery.js';
export { ReadBudget, ReadLimitError, READ_RATE_PER_S, READ_BURST, type ReadOptions } from './readBudget.js';
export { readPassport, verdictFor, TESTED_VERSIONS, type Passport, type PassportTarget, type Verdict } from './passport.js';
export { toIdentity, parseRobotWare } from './identity.js';
export {
  ReplayModeError, NotRecordedError, RecordingActiveError, RecordingFailedError, RecordingBoundsError,
  type ClientTapSink, type PendingCall, type TapHost, type TappedManagerView, type SecretSource, type RecorderControl,
  type ReplayControl, type FrameObserver, type FrameObservation, type StreamEndpoint, type ReplayHub,
} from './recording/contract.js';
export {
  Recorder, defaultRecordingDir, prepareRecordingFolder, realRecordingFiles, clientVersion, planRecording, RECORDING_MARKERS,
  type RecorderOptions, type RecorderTimers, type RecordingFiles,
} from './recording/recorder.js';
export {
  RECORDING_LIMIT_DEFAULTS, RECORDING_LIMIT_BOUNDS, FRAME_LINE_MAX_BYTES, limitsProblem, tightenLimits,
  recordingSessionName, recordingPartName,
} from './recording/writer.js';
export {
  MASK, MASKING_RULES, SecretValues, toPlainJson, maskFrame, maskRecordValue, maskRapidSecrets, isSecretMethod, type Json,
} from './recording/mask.js';
export { ClientTap, tapObject, tapFunction, type SinkSource } from './recording/tap.js';
export {
  registerRecordingRoutes, noRecordingStatus, RECORDING_PATH, RECORDING_START_PATH, RECORDING_STOP_PATH,
  type RecordingRouteDeps,
} from './recordingRoutes.js';
export {
  readRecording, parseRecording, parsePartRange, ReplayReadError, REPLAY_MAX_BYTES,
  type Recording, type PartRange, type ReplayFrame, type RecordingPartText,
} from './replay/reader.js';
export { ReplayStream, CLOSE_REPLAY_RESTART, LOOP_DELAY_MS, type ReplayStreamOptions } from './replay/stream.js';
export { ReplayFleet, NOT_IN_RECORDING } from './replay/fleet.js';
export {
  registerReplayRoutes, REPLAY_PATH, REPLAY_CONTROL_PATH, REPLAY_REFUSED_ROUTES, type ReplayRouteDeps,
} from './replayRoutes.js';
export { createReplayDaemon, type ReplayDaemon, type ReplayDaemonOptions } from './replayDaemon.js';
export * from './schema/v0.js';
export * from './schema/recording.js';
