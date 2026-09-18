import type { PrescriptionVersion, TelemetryEvent } from "./contracts.ts";

export interface SafetyPolicy {
  /** 心率连续高于上限达到该秒数才判定“持续超限” */
  sustainedOverLimitSeconds: number;
  /** 暂停后观察恢复速度的时间窗（秒） */
  recoveryWindowSeconds: number;
  /** 时间窗内心率至少应下降的 bpm，否则视为恢复过慢 */
  recoveryMinDropBpm: number;
  /** 命中即停止的症状清单（与处方禁忌合并判定） */
  stopSymptoms: string[];
  /** 到达延迟超过该秒数即视为迟到数据 */
  lateThresholdSeconds: number;
}

export const DEFAULT_POLICY: SafetyPolicy = {
  sustainedOverLimitSeconds: 60,
  recoveryWindowSeconds: 120,
  recoveryMinDropBpm: 12,
  stopSymptoms: ["chest-tightness", "chest-pain", "severe-dyspnea", "syncope", "dizziness"],
  lateThresholdSeconds: 30,
};

export type EvaluatorPhase = "active" | "paused" | "closed";

export interface RuleDecision {
  action: "continue" | "pause" | "stop" | "seek-help";
  rule: string;
  reason: string;
  evidenceEventIds: string[];
}

export type EvalOutcome =
  | { kind: "recorded" }
  /** 迟到数据：只补充复核证据，绝不产生实时指令 */
  | { kind: "late"; violatedLimits: boolean }
  | { kind: "decision"; decision: RuleDecision };

/**
 * 单课程安全评估器。所有规则按事件时间（capturedAt）评估；
 * 评估器只输出“决定”，指令是否下发由课程服务决定——
 * 迟到、乱序或课程已结束时到达的数据一律走 late 分支。
 */
export class SessionSafetyEvaluator {
  private phase: EvaluatorPhase = "active";
  private maxCapturedMs = Number.NEGATIVE_INFINITY;
  private overRun: { eventId: string; capturedMs: number }[] = [];
  private pausedAtMs: number | undefined;
  private hrAtPause: number | undefined;
  private readonly rx: PrescriptionVersion;
  private readonly policy: SafetyPolicy;

  constructor(rx: PrescriptionVersion, policy: SafetyPolicy) {
    this.rx = rx;
    this.policy = policy;
  }

  get currentPhase(): EvaluatorPhase {
    return this.phase;
  }

  close(): void {
    this.phase = "closed";
  }

  ingest(event: TelemetryEvent): EvalOutcome {
    const capturedMs = Date.parse(event.capturedAt);
    const receivedMs = Date.parse(event.receivedAt);
    const late =
      this.phase === "closed" ||
      receivedMs - capturedMs > this.policy.lateThresholdSeconds * 1000 ||
      capturedMs < this.maxCapturedMs;
    if (late) {
      return { kind: "late", violatedLimits: this.violatesLimits(event) };
    }
    if (capturedMs > this.maxCapturedMs) this.maxCapturedMs = capturedMs;

    if (event.symptom !== undefined) {
      const decision = this.onSymptom(event.symptom, event.eventId);
      if (decision !== undefined) return { kind: "decision", decision };
    }
    if (event.heartRate !== undefined) {
      const decision = this.onHeartRate(event.heartRate, event.eventId, capturedMs);
      if (decision !== undefined) return { kind: "decision", decision };
    }
    return { kind: "recorded" };
  }

  private violatesLimits(event: TelemetryEvent): boolean {
    if (event.heartRate !== undefined && event.heartRate > this.rx.heartRateZone.maximum) return true;
    if (event.symptom !== undefined && this.stopSymptomSet().has(event.symptom)) return true;
    return false;
  }

  private stopSymptomSet(): Set<string> {
    return new Set([...this.policy.stopSymptoms, ...this.rx.contraindications]);
  }

  private onSymptom(symptom: string, eventId: string): RuleDecision | undefined {
    if (this.stopSymptomSet().has(symptom)) {
      this.phase = "closed";
      return {
        action: "stop",
        rule: "stop-symptom",
        reason: `症状「${symptom}」命中停止规则（处方禁忌或安全症状清单），立即停止训练`,
        evidenceEventIds: [eventId],
      };
    }
    if (this.phase === "active") {
      this.phase = "paused";
      return {
        action: "pause",
        rule: "symptom-caution",
        reason: `症状「${symptom}」未列入停止清单，谨慎暂停并等待复核`,
        evidenceEventIds: [eventId],
      };
    }
    return undefined;
  }

  private onHeartRate(heartRate: number, eventId: string, capturedMs: number): RuleDecision | undefined {
    const max = this.rx.heartRateZone.maximum;

    if (this.phase === "paused") {
      if (heartRate <= max) {
        this.phase = "active";
        this.overRun = [];
        this.pausedAtMs = undefined;
        this.hrAtPause = undefined;
        return {
          action: "continue",
          rule: "recovered-to-zone",
          reason: `心率 ${heartRate} bpm 已回到处方上限 ${max} 以内，可继续训练`,
          evidenceEventIds: [eventId],
        };
      }
      const pausedForMs = this.pausedAtMs === undefined ? 0 : capturedMs - this.pausedAtMs;
      const drop = (this.hrAtPause ?? heartRate) - heartRate;
      if (pausedForMs >= this.policy.recoveryWindowSeconds * 1000 && drop < this.policy.recoveryMinDropBpm) {
        this.phase = "closed";
        return {
          action: "seek-help",
          rule: "recovery-too-slow",
          reason: `暂停 ${Math.round(pausedForMs / 1000)} 秒后心率仅下降 ${drop} bpm（要求 ≥ ${this.policy.recoveryMinDropBpm}），恢复过慢，终止训练并请求协助`,
          evidenceEventIds: [eventId],
        };
      }
      return undefined;
    }

    if (heartRate > max) {
      this.overRun.push({ eventId, capturedMs });
      const first = this.overRun[0];
      if (first !== undefined && capturedMs - first.capturedMs >= this.policy.sustainedOverLimitSeconds * 1000) {
        this.phase = "paused";
        this.pausedAtMs = capturedMs;
        this.hrAtPause = heartRate;
        const seconds = Math.round((capturedMs - first.capturedMs) / 1000);
        return {
          action: "pause",
          rule: "sustained-over-limit",
          reason: `心率持续 ${seconds} 秒高于处方上限 ${max} bpm，暂停训练`,
          evidenceEventIds: this.overRun.map((r) => r.eventId),
        };
      }
      return undefined;
    }

    this.overRun = [];
    return undefined;
  }
}
