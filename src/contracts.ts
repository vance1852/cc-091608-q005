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
}
