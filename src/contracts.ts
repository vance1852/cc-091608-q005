/**
 * 心脏康复训练安全服务 —— 临床契约
 *
 * 时间语义约定（贯穿全部模块）：
 * - capturedAt：设备/患者侧事件实际发生时间（生理与症状的临床时间）。
 * - receivedAt：服务器收到事件的时间；实时指令只能基于“已收到”的证据。
 * - decidedAt / issuedAt / sealedAt：服务器时钟写出的处理时间，绝不用 capturedAt 倒推。
 */

export type SessionState = "active" | "paused" | "stopped" | "under-review" | "completed";

export type Iso8601 = string;

/** 强度区间，单位 bpm。 */
export interface HeartRateZone {
  minimum: number;
  maximum: number;
}

export interface PrescriptionVersion {
  prescriptionId: string;
  version: number;
  patientId: string;
  validFrom: string;
  validUntil: string;
  heartRateZone: HeartRateZone;
  durationMinutes: number;
  contraindications: string[];
  signedBy: string;
}

/**
 * 处方信封：payload 经治疗师签名密钥签发后才允许下发。
 * 验签内容为处方字段的规范化 JSON（见 crypto.ts）。
 */
export interface SignedPrescription {
  prescription: PrescriptionVersion;
  /** hex(Ed25519 签名) */
  signature: string;
  /** 签名密钥标识，用于轮换与追责 */
  keyId: string;
}

export interface TelemetryEvent {
  eventId: string;
  sessionId: string;
  capturedAt: string;
  receivedAt: string;
  heartRate?: number;
  symptom?: string;
}

export type SafetyAction = "continue" | "pause" | "stop" | "seek-help";

export type DecisionBasis = "real-time" | "review-only";

export type SafetyReasonCode =
  | "contraindicated-symptom"
  | "sustained-heart-rate-over-limit"
  | "insufficient-recovery"
  | "symptom-with-elevated-heart-rate"
  | "prescription-recalled"
  | "patient-requested-help"
  | "within-limits";

/**
 * 安全决定。每条决定都必须能追到：
 * evidenceEventIds（原始遥测/症状）→ SafetyDecision → DeviceCommand（如有）→ 设备确认。
 */
export interface SafetyDecision {
  decisionId: string;
  sessionId: string;
  action: SafetyAction;
  reason: SafetyReasonCode;
  basis: DecisionBasis;
  evidenceEventIds: string[];
  /** 服务器做出决定的时间（处理时间，非事件时间） */
  decidedAt: string;
  /** 决定所依据证据的临床时间窗，便于复核 */
  evidenceCapturedFrom?: string;
  evidenceCapturedTo?: string;
  /** 若 basis=real-time 且需要设备动作，关联已下发指令 */
  commandId?: string;
  /** 关联的安全事件 */
  safetyEventId?: string;
  detail: string;
}

/** 下发给腕表/训练设备的实时指令。issuedAt 只取服务器时钟。 */
export interface DeviceCommand {
  commandId: string;
  sessionId: string;
  action: Extract<SafetyAction, "pause" | "stop">;
  reason: SafetyReasonCode;
  issuedAt: string;
  basedOnDecisionId: string;
}

/** 设备对指令的确认，必须回到同一课程记录。 */
export interface DeviceAcknowledgement {
  eventId: string;
  sessionId: string;
  commandId: string;
  status: "acknowledged" | "failed";
  at: string;
  detail?: string;
}

/** 患者主动求助。 */
export interface HelpRequest {
  eventId: string;
  sessionId: string;
  at: string;
  message?: string;
}

/** 治疗师复核结论；复核是关闭安全事件的唯一途径。 */
export interface ClinicianReview {
  reviewId: string;
  sessionId: string;
  reviewerId: string;
  at: string;
  closeSafetyEventIds: string[];
  notes: string;
}

export type SafetyEventStatus = "open" | "closed";
export type SafetyEventSeverity = "critical" | "caution";

/** 安全事件：症状/超限/撤回等触发，关闭前禁止完成徽章。 */
export interface SafetyEvent {
  safetyEventId: string;
  sessionId: string;
  reason: SafetyReasonCode;
  severity: SafetyEventSeverity;
  openedAt: string;
  triggerDecisionIds: string[];
  evidenceEventIds: string[];
  status: SafetyEventStatus;
  closedByReviewId?: string;
  closedAt?: string;
  clinicianNotes?: string;
}

/** 设备自报的达标徽章声称；服务器独立裁决，设备徽章不能凌驾临床限制。 */
export interface DeviceBadgeClaim {
  claimId: string;
  sessionId: string;
  badgeCode: string;
  at: string;
}

export type BadgeEligibilityStatus = "eligible" | "denied";

export interface BadgeEligibility {
  status: BadgeEligibilityStatus;
  sessionId: string;
  badgeCode: string;
  reasons: string[];
  openSafetyEventIds: string[];
  durationTargetMinutes: number;
  activeTrainingMinutes: number;
}

/** 课程开始时固定的处方绑定（深冻结快照，后续发版/撤回不得改写）。 */
export interface PrescriptionBinding {
  sessionId: string;
  prescriptionId: string;
  version: number;
  signature: string;
  keyId: string;
  /** 处方内容指纹，便于摘要追溯 */
  fingerprint: string;
  boundAt: string;
  /** 腕表自报的上周区间，与签署区间不一致时留痕，但绝不采用 */
  deviceReportedZone?: HeartRateZone;
  zoneMismatch: boolean;
}

export interface RecallNotice {
  prescriptionId: string;
  reason: string;
  recalledAt: string;
  /** 撤回时仍在进行的课程，将收到停止指令并记录原因 */
  affectedActiveSessionIds: string[];
}
