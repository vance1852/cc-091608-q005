/**
 * 安全规则评估。
 *
 * 关键时间纪律：
 * - 规则判据一律使用事件 capturedAt（临床时间）：心率持续超限、恢复速度、症状组合。
 * - 决定是否“实时可执行”取决于证据在服务器处理时刻（watermark）之前是否已收到：
 *   receivedAt <= watermark 的证据才能产生实时指令；迟到事件只生成 review-only 决定。
 * - 绝不按 capturedAt 倒推下发指令。
 */
import type {
  HeartRateZone,
  PrescriptionVersion,
  SafetyReasonCode,
  TelemetryEvent,
} from "./contracts.js";

/** 持续超限判据参数（秒）。值保守、可配置。 */
export interface SafetyRuleConfig {
  /** 心率超过上限并持续该时长 -> stop */
  overLimitHoldSeconds: number;
  /** 暂停/超限后，期望在该时长内回落到区间内（恢复速度） */
  recoveryWindowSeconds: number;
  /** 恢复窗口结束时允许高于上限的余量（bpm）；仍超出 -> stop */
  recoveryToleranceBpm: number;
  /** 禁忌症状：出现即 stop + seek-help */
  contraindicatedSymptoms: string[];
  /** 非禁忌但需关注的症状：合并心率偏高 -> pause；持续/偏高 -> stop */
  cautionarySymptoms: string[];
  /** 症状发生时心率超过该阈值视为“心率偏高”（默认取区间上限） */
  symptomElevatedBpm?: number;
}

export const DEFAULT_RULES: SafetyRuleConfig = {
  overLimitHoldSeconds: 60,
  recoveryWindowSeconds: 120,
  recoveryToleranceBpm: 5,
  // 心脏康复通用红旗症状
  contraindicatedSymptoms: [
    "chest-tightness",
    "chest-pain",
    "angina",
    "near-syncope",
    "syncope",
    "severe-dyspnea",
  ],
  cautionarySymptoms: ["mild-dyspnea", "dizziness", "palpitations", "excessive-fatigue"],
};

export type Severity = "none" | "caution" | "critical";

export interface RuleFinding {
  severity: Severity;
  reason: SafetyReasonCode;
  evidenceEventIds: string[];
  capturedFrom: string;
  capturedTo: string;
  detail: string;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function isContraindicated(symptom: string, rules: SafetyRuleConfig): boolean {
  return rules.contraindicatedSymptoms.includes(symptom);
}

export interface WatermarkedEvent extends TelemetryEvent {
  /** 该事件在 watermark 时刻是否已被服务器接收 */
  availableAtWatermark: boolean;
}

/**
 * 在给定 watermark（服务器当前处理时间）下评估。
 * 只有 receivedAt <= watermark 的事件可作实时证据；
 * late 事件不参与本时刻判定，由调用方走 review-only 流程补充复核证据。
 */
export function evaluateAtWatermark(
  prescription: PrescriptionVersion,
  events: TelemetryEvent[],
  watermark: Date,
  rules: SafetyRuleConfig = DEFAULT_RULES,
): { findings: RuleFinding[]; available: WatermarkedEvent[]; late: TelemetryEvent[] } {
  const available = events
    .filter((e) => ms(e.receivedAt) <= watermark.getTime())
    .map((e) => ({ ...e, availableAtWatermark: true }));
  const late = events.filter((e) => ms(e.receivedAt) > watermark.getTime());

  const findings = evaluateAvailable(prescription, available, rules);
  return { findings, available, late };
}

/**
 * 对“当时已收到”的事件按 capturedAt 时间线评估，返回所有命中的规则（按严重度排序），
 * 这样禁忌症状不会掩盖心率持续超限等并存证据。
 * 注意：可用事件的 capturedAt 可能早于 watermark（断连补传），这是允许的——
 * 判据按临床时间成立，但动作的 issuedAt 仍是 watermark，不能倒推。
 */
export function evaluateAvailable(
  prescription: PrescriptionVersion,
  events: Array<TelemetryEvent & { availableAtWatermark?: boolean }>,
  rules: SafetyRuleConfig = DEFAULT_RULES,
): RuleFinding[] {
  if (events.length === 0) return [];

  const ordered = [...events].sort((a, b) => ms(a.capturedAt) - ms(b.capturedAt));
  const { maximum } = prescription.heartRateZone;
  const elevatedThreshold = rules.symptomElevatedBpm ?? maximum;
  const findings: RuleFinding[] = [];

  // 规则 1（最高优先级）：禁忌症状，无论心率多少。
  const contra = ordered.find((e) => e.symptom !== undefined && isContraindicated(e.symptom, rules));
  if (contra && contra.symptom !== undefined) {
    findings.push({
      severity: "critical",
      reason: "contraindicated-symptom",
      evidenceEventIds: [contra.eventId],
      capturedFrom: contra.capturedAt,
      capturedTo: contra.capturedAt,
      detail: `患者报告禁忌症状「${contra.symptom}」，立即停止训练并求助`,
    });
  }

  // 规则 2：症状 + 心率偏高组合。
  const cautionSymptom = ordered.find(
    (e) => e.symptom !== undefined && rules.cautionarySymptoms.includes(e.symptom),
  );
  if (cautionSymptom && cautionSymptom.symptom !== undefined) {
    const hrAtSymptom = nearestHeartRateAtOrBefore(ordered, ms(cautionSymptom.capturedAt));
    if (hrAtSymptom !== null && hrAtSymptom.heartRate > elevatedThreshold) {
      findings.push({
        severity: "critical",
        reason: "symptom-with-elevated-heart-rate",
        evidenceEventIds: [cautionSymptom.eventId, hrAtSymptom.eventId],
        capturedFrom: hrAtSymptom.capturedAt,
        capturedTo: cautionSymptom.capturedAt,
        detail: `症状「${cautionSymptom.symptom}」合并心率 ${hrAtSymptom.heartRate} bpm 高于阈值 ${elevatedThreshold}`,
      });
    } else {
      findings.push({
        severity: "caution",
        reason: "symptom-with-elevated-heart-rate",
        evidenceEventIds: [cautionSymptom.eventId],
        capturedFrom: cautionSymptom.capturedAt,
        capturedTo: cautionSymptom.capturedAt,
        detail: `患者报告需关注症状「${cautionSymptom.symptom}」，先暂停评估`,
      });
    }
  }

  // 规则 3：心率持续超限。
  const overSpan = sustainedOverLimitSpan(ordered, maximum, rules.overLimitHoldSeconds * 1000);
  if (overSpan) {
    findings.push({
      severity: "critical",
      reason: "sustained-heart-rate-over-limit",
      evidenceEventIds: overSpan.events.map((e) => e.eventId),
      capturedFrom: overSpan.events[0]!.capturedAt,
      capturedTo: overSpan.events[overSpan.events.length - 1]!.capturedAt,
      detail: `心率持续超过上限 ${maximum} bpm 达 ${rules.overLimitHoldSeconds} 秒以上`,
    });
  }

  // 规则 4：恢复速度不足（一次超限后，窗口内未回落到上限+余量以内）。
  const recovery = insufficientRecovery(ordered, maximum, rules);
  if (recovery) {
    findings.push({
      severity: "critical",
      reason: "insufficient-recovery",
      evidenceEventIds: recovery.events.map((e) => e.eventId),
      capturedFrom: recovery.events[0]!.capturedAt,
      capturedTo: recovery.events[recovery.events.length - 1]!.capturedAt,
      detail: `超限后 ${rules.recoveryWindowSeconds} 秒内未回落到 ${maximum + rules.recoveryToleranceBpm} bpm 以下，恢复速度不足`,
    });
  }

  const rank: Record<Severity, number> = { critical: 0, caution: 1, none: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function nearestHeartRateAtOrBefore(
  ordered: TelemetryEvent[],
  capturedMs: number,
): (TelemetryEvent & { heartRate: number }) | null {
  let best: (TelemetryEvent & { heartRate: number }) | null = null;
  for (const e of ordered) {
    if (ms(e.capturedAt) > capturedMs) break;
    if (e.heartRate !== undefined) best = e as TelemetryEvent & { heartRate: number };
  }
  return best;
}

function sustainedOverLimitSpan(
  ordered: TelemetryEvent[],
  maximum: number,
  holdMs: number,
): { events: TelemetryEvent[] } | null {
  let run: TelemetryEvent[] = [];
  for (const e of ordered) {
    if (e.heartRate !== undefined && e.heartRate > maximum) {
      run.push(e);
      const first = run[0]!;
      const last = run[run.length - 1]!;
      if (ms(last.capturedAt) - ms(first.capturedAt) >= holdMs) {
        return { events: run };
      }
    } else if (e.heartRate !== undefined) {
      // 回到上限以内，持续计时中断
      run = [];
    }
    // 纯症状事件不中断也不延长心率序列
  }
  return null;
}

function insufficientRecovery(
  ordered: TelemetryEvent[],
  maximum: number,
  rules: SafetyRuleConfig,
): { events: TelemetryEvent[] } | null {
  const hr = ordered.filter((e): e is TelemetryEvent & { heartRate: number } => e.heartRate !== undefined);
  for (let i = 1; i < hr.length; i++) {
    const prev = hr[i - 1]!;
    const cur = hr[i]!;
    if (prev.heartRate > maximum && cur.heartRate > maximum + rules.recoveryToleranceBpm) {
      const gapSec = (ms(cur.capturedAt) - ms(prev.capturedAt)) / 1000;
      if (gapSec >= rules.recoveryWindowSeconds) {
        return { events: [prev, cur] };
      }
    }
  }
  return null;
}

/** 处方自带禁忌与上报症状的匹配（开课/复核留痕用）。 */
export function matchingContraindications(prescription: PrescriptionVersion, symptom: string): string[] {
  return prescription.contraindications.filter((c) => c === symptom || c.includes(symptom));
}

export function zoneContains(zone: HeartRateZone, bpm: number): boolean {
  return bpm >= zone.minimum && bpm <= zone.maximum;
}
