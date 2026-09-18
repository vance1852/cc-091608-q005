export type SessionState = "active" | "paused" | "stopped" | "under-review" | "completed";

export interface PrescriptionVersion {
  prescriptionId: string;
  version: number;
  patientId: string;
  validFrom: string;
  validUntil: string;
  heartRateZone: { minimum: number; maximum: number };
  durationMinutes: number;
  contraindications: string[];
  signedBy: string;
}

export interface TelemetryEvent {
  eventId: string;
  sessionId: string;
  capturedAt: string;
  receivedAt: string;
  heartRate?: number;
  symptom?: string;
}

export interface SafetyDecision {
  decisionId: string;
  sessionId: string;
  action: "continue" | "pause" | "stop" | "seek-help";
  evidenceEventIds: string[];
  decidedAt: string;
  /** 触发该决定的规则标识，用于从课程摘要追溯 */
  rule: string;
  /** 面向临床的可读理由 */
  reason: string;
}

/* ---------- 处方生命周期 ---------- */

export type PrescriptionStatus = "draft" | "signed" | "withdrawn";

/** 未签署的处方草稿：内容齐全但缺少签署人，不能下发。 */
export interface PrescriptionDraft {
  prescriptionId: string;
  version: number;
  patientId: string;
  validFrom: string;
  validUntil: string;
  heartRateZone: { minimum: number; maximum: number };
  durationMinutes: number;
  contraindications: string[];
}

/**
 * 处方版本记录。签署后 draft 与 signed 被冻结，任何调整只能发布新版本；
 * 撤回只是追加状态，不改写已签署内容（临床记录必须可回溯）。
 */
export interface PrescriptionRecord {
  draft: PrescriptionDraft;
  status: PrescriptionStatus;
  signed?: { signedBy: string; signedAt: string };
  withdrawal?: { reason: string; withdrawnAt: string };
}

/* ---------- 设备指令与确认 ---------- */

export interface DeviceCommand {
  commandId: string;
  sessionId: string;
  kind: "pause" | "stop";
  reason: string;
  /** 服务器作出决定的到达时间，绝不按采集时间倒推 */
  issuedAt: string;
  /** 每条指令都能追溯到触发它的安全决定 */
  decisionId: string;
}

export interface CommandAcknowledgment {
  commandId: string;
  sessionId: string;
  deviceId: string;
  acknowledgedAt: string;
}

export interface HelpRequest {
  requestId: string;
  sessionId: string;
  requestedAt: string;
  note?: string;
}

export interface TherapistReview {
  reviewId: string;
  sessionId: string;
  safetyEventId: string;
  reviewedBy: string;
  reviewedAt: string;
  outcome: "closed" | "escalated";
  note?: string;
}

/* ---------- 安全事件、徽章、封存 ---------- */

export interface SafetyIncident {
  safetyEventId: string;
  sessionId: string;
  status: "open" | "closed";
  openedByDecisionId: string;
  openedAt: string;
  /** 证据随迟到数据到达而补充，只增不减 */
  evidenceEventIds: string[];
  decisionIds: string[];
  closedByReviewId?: string;
  closedAt?: string;
}

export interface CompletionBadge {
  badgeId: string;
  sessionId: string;
  awardedAt: string;
  durationMinutes: number;
}

/** 设备侧达标徽章：仅作记录，不参与任何安全门控。 */
export interface DeviceBadgeNotice {
  sessionId: string;
  label: string;
  reportedAt: string;
}

export interface ArchiveRecord {
  archiveId: string;
  sessionId: string;
  sealedAt: string;
  retentionUntil: string;
  eventCount: number;
}

/** 删除原始遥测的请求一律被拒绝并留痕。 */
export interface DeletionAttempt {
  sessionId: string;
  requestedBy: string;
  eventIds: string[];
  requestedAt: string;
  outcome: "rejected";
  reason: string;
}

/* ---------- 课程摘要（追溯视图） ---------- */

export type SessionEndKind = "stopped" | "duration-met";

export interface DecisionTrace {
  decisionId: string;
  rule: string;
  action: SafetyDecision["action"];
  reason: string;
  decidedAt: string;
  evidenceEventIds: string[];
  commandId?: string;
}

export interface SafetyIncidentSummary {
  safetyEventId: string;
  status: "open" | "closed";
  openedByDecisionId: string;
  openedAt: string;
  evidenceEventIds: string[];
  decisionIds: string[];
  closedByReviewId?: string;
  closedAt?: string;
}

export interface SessionSummary {
  sessionId: string;
  patientId: string;
  prescriptionRef: { prescriptionId: string; version: number };
  state: SessionState;
  startedAt: string;
  endedAt?: string;
  endedAs?: SessionEndKind;
  telemetryCount: number;
  /** 迟到（断连补传/乱序/超阈值）事件，仅作复核证据 */
  lateEventIds: string[];
  decisions: DecisionTrace[];
  safetyEvents: SafetyIncidentSummary[];
  commands: DeviceCommand[];
  acknowledgments: CommandAcknowledgment[];
  helpRequests: HelpRequest[];
  reviews: TherapistReview[];
  deviceBadges: DeviceBadgeNotice[];
  deletionAttempts: DeletionAttempt[];
  archives: ArchiveRecord[];
  badge?: CompletionBadge;
}
