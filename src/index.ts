/**
 * 心脏康复训练安全服务 —— 公共 API。
 */
export * from "./contracts.js";
export { ManualClock, type Clock } from "./clock.js";
export { canonicalJSON, sha256Hex, signCanonical, verifyCanonical } from "./crypto.js";
export {
  PrescriptionRegistry,
  TherapistKeyring,
  type StoredPrescription,
} from "./prescription.js";
export {
  DEFAULT_RULES,
  evaluateAvailable,
  evaluateAtWatermark,
  zoneContains,
  matchingContraindications,
  type SafetyRuleConfig,
  type RuleFinding,
  type Severity,
  type WatermarkedEvent,
} from "./safety-engine.js";
export {
  SessionService,
  RehabSession,
  CounterIds,
  type IdFactory,
  type StartSessionParams,
  type IngestResult,
} from "./session-service.js";
export {
  SessionLog,
  type LogEntry,
  type LogEntryType,
  type LogEntryPayloads,
  type ArchiveManifest,
  type ResumeRecord,
} from "./session-log.js";
export {
  buildSummary,
  type SessionSummary,
  type DecisionTrace,
  type SafetyEventTrace,
  type EvidenceTrace,
} from "./summary.js";
