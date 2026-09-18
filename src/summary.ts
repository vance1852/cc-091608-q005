/**
 * 课程摘要与安全决定追溯。
 * 从摘要必须能追到每条安全决定：证据事件 → 决定 → 指令 → 设备确认 → 安全事件 → 复核关闭。
 */
import type {
  ClinicianReview,
  DeviceAcknowledgement,
  DeviceCommand,
  SafetyDecision,
  SafetyEvent,
  TelemetryEvent,
} from "./contracts.js";
import type { RehabSession } from "./session-service.js";

export interface EvidenceTrace {
  eventId: string;
  capturedAt: string;
  receivedAt: string;
  heartRate?: number;
  symptom?: string;
  /** receivedAt - capturedAt（毫秒），直观呈现迟到/断连 */
  latencyMs: number;
}

export interface DecisionTrace {
  decisionId: string;
  action: SafetyDecision["action"];
  reason: SafetyDecision["reason"];
  basis: SafetyDecision["basis"];
  decidedAt: string;
  detail: string;
  evidence: EvidenceTrace[];
  command?: {
    commandId: DeviceCommand["commandId"];
    action: DeviceCommand["action"];
    issuedAt: string;
    acknowledgement?: {
      eventId: DeviceAcknowledgement["eventId"];
      status: DeviceAcknowledgement["status"];
      at: string;
    };
  };
  safetyEventId?: string;
  safetyEventStatus?: SafetyEvent["status"];
}

export interface SafetyEventTrace {
  safetyEventId: string;
  reason: SafetyEvent["reason"];
  severity: SafetyEvent["severity"];
  status: SafetyEvent["status"];
  openedAt: string;
  closedAt?: string;
  closedByReviewId?: string;
  clinicianNotes?: string;
  decisionIds: string[];
  evidenceEventIds: string[];
}

export interface SessionSummary {
  sessionId: string;
  state: RehabSession["state"];
  boundPrescription: {
    prescriptionId: string;
    version: number;
    fingerprint: string;
    boundAt: string;
    signedBy: string;
    zone: { minimum: number; maximum: number };
    durationMinutes: number;
    contraindications: string[];
    deviceReportedZone?: { minimum: number; maximum: number };
    zoneMismatch: boolean;
  };
  counts: {
    telemetry: number;
    decisions: number;
    commands: number;
    acknowledgements: number;
    helpRequests: number;
    reviews: number;
    safetyEventsOpen: number;
    safetyEventsTotal: number;
  };
  decisions: DecisionTrace[];
  safetyEvents: SafetyEventTrace[];
  reviews: ClinicianReview[];
  badgeClaims: RehabSession["badgeClaims"];
  archive: RehabSession["archive"];
  chainValid: boolean;
}

export function buildSummary(session: RehabSession): SessionSummary {
  const eventsById = new Map<string, TelemetryEvent>(session.events.map((e) => [e.eventId, e]));

  const decisions: DecisionTrace[] = session.decisions.map((d) => {
    const evidence: EvidenceTrace[] = d.evidenceEventIds.map((id) => {
      const e = eventsById.get(id);
      if (!e) {
        // 非遥测证据（如撤回/求助）在各自分组里追溯；这里保留占位。
        return { eventId: id, capturedAt: "(非遥测)", receivedAt: "(非遥测)", latencyMs: 0 };
      }
      return {
        eventId: e.eventId,
        capturedAt: e.capturedAt,
        receivedAt: e.receivedAt,
        ...(e.heartRate !== undefined ? { heartRate: e.heartRate } : {}),
        ...(e.symptom !== undefined ? { symptom: e.symptom } : {}),
        latencyMs: new Date(e.receivedAt).getTime() - new Date(e.capturedAt).getTime(),
      };
    });

    let command: DecisionTrace["command"];
    if (d.commandId) {
      const cmd = session.commands.find((c) => c.commandId === d.commandId);
      const ack = cmd ? session.acknowledgements.find((a) => a.commandId === cmd.commandId) : undefined;
      command = cmd
        ? {
            commandId: cmd.commandId,
            action: cmd.action,
            issuedAt: cmd.issuedAt,
            ...(ack ? { acknowledgement: { eventId: ack.eventId, status: ack.status, at: ack.at } } : {}),
          }
        : undefined;
    }

    const safetyEvent = d.safetyEventId
      ? session.safetyEvents.find((e) => e.safetyEventId === d.safetyEventId)
      : undefined;

    return {
      decisionId: d.decisionId,
      action: d.action,
      reason: d.reason,
      basis: d.basis,
      decidedAt: d.decidedAt,
      detail: d.detail,
      evidence,
      ...(command ? { command } : {}),
      ...(d.safetyEventId ? { safetyEventId: d.safetyEventId } : {}),
      ...(safetyEvent ? { safetyEventStatus: safetyEvent.status } : {}),
    };
  });

  const safetyEvents: SafetyEventTrace[] = session.safetyEvents.map((e) => ({
    safetyEventId: e.safetyEventId,
    reason: e.reason,
    severity: e.severity,
    status: e.status,
    openedAt: e.openedAt,
    ...(e.closedAt ? { closedAt: e.closedAt } : {}),
    ...(e.closedByReviewId ? { closedByReviewId: e.closedByReviewId } : {}),
    ...(e.clinicianNotes ? { clinicianNotes: e.clinicianNotes } : {}),
    decisionIds: e.triggerDecisionIds,
    evidenceEventIds: e.evidenceEventIds,
  }));

  let chainValid = true;
  try {
    session.log.verifyChain();
  } catch {
    chainValid = false;
  }

  const b = session.binding;
  return {
    sessionId: session.sessionId,
    state: session.state,
    boundPrescription: {
      prescriptionId: b.prescriptionId,
      version: b.version,
      fingerprint: b.fingerprint,
      boundAt: b.boundAt,
      signedBy: session.prescriptionSnapshot.signedBy,
      zone: session.prescriptionSnapshot.heartRateZone,
      durationMinutes: session.prescriptionSnapshot.durationMinutes,
      contraindications: session.prescriptionSnapshot.contraindications,
      ...(b.deviceReportedZone ? { deviceReportedZone: b.deviceReportedZone } : {}),
      zoneMismatch: b.zoneMismatch,
    },
    counts: {
      telemetry: session.events.length,
      decisions: session.decisions.length,
      commands: session.commands.length,
      acknowledgements: session.acknowledgements.length,
      helpRequests: session.helpRequests.length,
      reviews: session.reviews.length,
      safetyEventsOpen: session.openSafetyEvents.length,
      safetyEventsTotal: session.safetyEvents.length,
    },
    decisions,
    safetyEvents,
    reviews: session.reviews,
    badgeClaims: session.badgeClaims,
    archive: session.archive,
    chainValid,
  };
}
