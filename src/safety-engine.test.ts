/**
 * 安全引擎规则单元测试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAvailable, DEFAULT_RULES, type SafetyRuleConfig } from "./safety-engine.js";
import type { PrescriptionVersion, TelemetryEvent } from "./contracts.js";

const rx: PrescriptionVersion = {
  prescriptionId: "rx",
  version: 1,
  patientId: "P",
  validFrom: "2026-09-15T08:00:00+08:00",
  validUntil: "2026-09-15T20:00:00+08:00",
  heartRateZone: { minimum: 95, maximum: 125 },
  durationMinutes: 30,
  contraindications: ["chest-tightness"],
  signedBy: "t",
};

const rules: SafetyRuleConfig = {
  ...DEFAULT_RULES,
  overLimitHoldSeconds: 60,
  recoveryWindowSeconds: 120,
  recoveryToleranceBpm: 5,
};

function t(hms: string): string {
  if (hms.startsWith("2026-")) return hms;
  const time = hms.split("+")[0]!;
  return `2026-09-15T${time}+08:00`;
}

function hr(eventId: string, hms: string, heartRate: number): TelemetryEvent {
  const iso = t(hms);
  return { eventId, sessionId: "s", capturedAt: iso, receivedAt: iso, heartRate };
}

function symptom(eventId: string, hms: string, value: string): TelemetryEvent {
  const iso = t(hms);
  return { eventId, sessionId: "s", capturedAt: iso, receivedAt: iso, symptom: value };
}

test("区间内心率不产生命中", () => {
  const findings = evaluateAvailable(rx, [hr("a", "09:05:00+08:00", 110), hr("b", "09:06:00+08:00", 120)], rules);
  assert.equal(findings.length, 0);
});

test("单次瞬时超限不触发持续超限", () => {
  const findings = evaluateAvailable(
    rx,
    [hr("a", "09:05:00+08:00", 130), hr("b", "09:05:30+08:00", 120)],
    rules,
  );
  assert.equal(findings.some((f) => f.reason === "sustained-heart-rate-over-limit"), false);
});

test("超限持续满 60 秒触发", () => {
  const findings = evaluateAvailable(
    rx,
    [hr("a", "09:05:00+08:00", 130), hr("b", "09:06:00+08:00", 132)],
    rules,
  );
  const f = findings.find((x) => x.reason === "sustained-heart-rate-over-limit");
  assert.ok(f);
  assert.equal(f!.severity, "critical");
  assert.deepEqual(f!.evidenceEventIds, ["a", "b"]);
});

test("超限后回到区间内会中断持续计时", () => {
  const findings = evaluateAvailable(
    rx,
    [hr("a", "09:05:00+08:00", 130), hr("b", "09:05:40+08:00", 124), hr("c", "09:06:30+08:00", 128)],
    rules,
  );
  assert.equal(findings.some((f) => f.reason === "sustained-heart-rate-over-limit"), false);
});

test("恢复速度不足：120 秒后仍高于上限+余量", () => {
  const findings = evaluateAvailable(
    rx,
    [hr("a", "09:05:00+08:00", 130), hr("b", "09:07:00+08:00", 132)],
    rules,
  );
  const f = findings.find((x) => x.reason === "insufficient-recovery");
  assert.ok(f);
  assert.deepEqual(f!.evidenceEventIds, ["a", "b"]);
});

test("恢复速度达标（窗口内回落到上限+余量以内）不触发", () => {
  const findings = evaluateAvailable(
    rx,
    [hr("a", "09:05:00+08:00", 130), hr("b", "09:07:00+08:00", 129)],
    rules,
  );
  assert.equal(findings.some((f) => f.reason === "insufficient-recovery"), false);
});

test("禁忌症状优先级最高且与心率无关", () => {
  const events: TelemetryEvent[] = [
    hr("a", "09:05:00+08:00", 110),
    symptom("s", "09:05:10+08:00", "chest-tightness"),
  ];
  const findings = evaluateAvailable(rx, events, rules);
  assert.equal(findings[0]!.reason, "contraindicated-symptom");
  assert.equal(findings[0]!.severity, "critical");
});

test("关注症状在心率正常时只产生 caution（暂停）", () => {
  const events: TelemetryEvent[] = [
    hr("a", "09:05:00+08:00", 110),
    symptom("s", "09:05:10+08:00", "dizziness"),
  ];
  const findings = evaluateAvailable(rx, events, rules);
  const f = findings.find((x) => x.reason === "symptom-with-elevated-heart-rate");
  assert.ok(f);
  assert.equal(f!.severity, "caution");
});

test("关注症状合并心率偏高升级为 critical", () => {
  const events: TelemetryEvent[] = [
    hr("a", "09:05:00+08:00", 130),
    symptom("s", "09:05:10+08:00", "dizziness"),
  ];
  const findings = evaluateAvailable(rx, events, rules);
  const f = findings.find((x) => x.reason === "symptom-with-elevated-heart-rate");
  assert.equal(f!.severity, "critical");
});

test("症状与持续超限并存时同时返回，互不掩盖", () => {
  const events: TelemetryEvent[] = [
    hr("a", "09:05:00+08:00", 130),
    symptom("s", "09:05:30+08:00", "chest-tightness"),
    hr("b", "09:06:05+08:00", 133),
  ];
  const reasons = evaluateAvailable(rx, events, rules).map((f) => f.reason);
  assert.ok(reasons.includes("contraindicated-symptom"));
  assert.ok(reasons.includes("sustained-heart-rate-over-limit"));
});

test("判据按 capturedAt 时间线，乱序送达不影响结论", () => {
  const events = [
    hr("b", "09:06:00+08:00", 132),
    hr("a", "09:05:00+08:00", 130),
  ];
  const findings = evaluateAvailable(rx, events, rules);
  const f = findings.find((x) => x.reason === "sustained-heart-rate-over-limit");
  assert.ok(f);
  assert.equal(f!.capturedFrom, "2026-09-15T09:05:00+08:00");
});
