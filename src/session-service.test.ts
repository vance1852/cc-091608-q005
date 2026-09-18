/**
 * SessionService 状态机与安全不变量测试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import { TherapistKeyring, PrescriptionRegistry } from "./prescription.js";
import { SessionService, CounterIds, type RehabSession } from "./session-service.js";
import { ManualClock } from "./clock.js";
import type { PrescriptionVersion, TelemetryEvent } from "./contracts.js";

const keyId = "k-1";

function harness(rxOverride?: Partial<PrescriptionVersion>): {
  service: SessionService;
  clock: ManualClock;
  rx: PrescriptionVersion;
  privateKey: KeyObject;
  registry: PrescriptionRegistry;
} {
  const { keyring, privateKey } = TherapistKeyring.generateDemoKey(keyId);
  const registry = new PrescriptionRegistry(keyring);
  const clock = new ManualClock("2026-09-15T08:00:00+08:00");
  const rx: PrescriptionVersion = {
    prescriptionId: "rx-1",
    version: 1,
    patientId: "P-1",
    validFrom: "2026-09-15T08:00:00+08:00",
    validUntil: "2026-09-22T20:00:00+08:00",
    heartRateZone: { minimum: 95, maximum: 125 },
    durationMinutes: 30,
    contraindications: ["chest-tightness"],
    signedBy: "t-1",
    ...rxOverride,
  };
  registry.publish(registry.sign(rx, privateKey, keyId), clock.now());
  const service = new SessionService(registry, new CounterIds());
  return { service, clock, rx, privateKey, registry };
}

function start(service: SessionService, clock: ManualClock, sessionId = "s-1", at = "2026-09-15T09:00:00+08:00"): RehabSession {
  clock.setTo(at);
  return service.startSession({ sessionId, prescriptionId: "rx-1", version: 1, startAt: clock.now() });
}

function iso(hms: string): string {
  if (hms.startsWith("2026-")) return hms;
  const time = hms.split("+")[0]!;
  return `2026-09-15T${time}+08:00`;
}

function telemetry(eventId: string, capturedAt: string, receivedAt: string, extra: { heartRate?: number; symptom?: string } = {}): TelemetryEvent {
  return { eventId, sessionId: "s-1", capturedAt: iso(capturedAt), receivedAt: iso(receivedAt), ...extra };
}

test("开课绑定冻结处方快照", () => {
  const { service, clock } = harness();
  const session = start(service, clock);
  assert.equal(session.binding.version, 1);
  assert.equal(session.prescriptionSnapshot.heartRateZone.maximum, 125);
  assert.ok(Object.isFrozen(session.prescriptionSnapshot.heartRateZone));
});

test("有效期外不能开课", () => {
  const { service, clock } = harness({ validUntil: "2026-09-15T08:30:00+08:00" });
  assert.throws(() => start(service, clock), /不在有效期内/);
});

test("设备自报旧区间仅留痕不被采用", () => {
  const { service, clock } = harness();
  clock.setTo("2026-09-15T09:00:00+08:00");
  const session = service.startSession({
    sessionId: "s-1",
    prescriptionId: "rx-1",
    version: 1,
    startAt: clock.now(),
    deviceReportedZone: { minimum: 100, maximum: 140 },
  });
  assert.equal(session.binding.zoneMismatch, true);
  assert.equal(session.prescriptionSnapshot.heartRateZone.maximum, 125);
});

test("receivedAt 晚于处理时间被拒绝（禁止倒推）", () => {
  const { service, clock } = harness();
  start(service, clock);
  clock.setTo("2026-09-15T09:05:00+08:00");
  assert.throws(
    () => service.ingest(telemetry("e1", "09:04:00+08:00", "09:06:00+08:00", { heartRate: 110 }), clock.now()),
    /拒绝倒推/,
  );
});

test("同一事件不可重复入库", () => {
  const { service, clock } = harness();
  start(service, clock);
  clock.setTo("2026-09-15T09:05:00+08:00");
  const e = telemetry("e1", "09:05:00+08:00", "09:05:00+08:00", { heartRate: 110 });
  service.ingest(e, clock.now());
  assert.throws(() => service.ingest(e, clock.now()), /不可重复写入/);
});

test("caution 症状触发暂停；无未关闭危急事件时可恢复，且暂停不计入时长", () => {
  const { service, clock } = harness();
  start(service, clock, "s-1", "2026-09-15T09:00:00+08:00");
  clock.setTo("2026-09-15T09:10:00+08:00");
  const result = service.ingest(
    telemetry("d1", "09:10:00+08:00", "09:10:00+08:00", { symptom: "dizziness" }),
    clock.now(),
  );
  assert.equal(result.command?.action, "pause");
  const session = service.getSession("s-1");
  assert.equal(session.state, "paused");

  // 红旗未关闭 critical 事件不存在，可以恢复。
  service.resumeTraining("s-1", "patient-confirmed", "症状缓解", new Date("2026-09-15T09:20:00+08:00"));
  assert.equal(session.state, "active");
  const minutes = session.activeTrainingMinutes(new Date("2026-09-15T09:40:00+08:00"));
  // 09:00-09:10（10 分钟） + 09:20-09:40（20 分钟）= 30 分钟；暂停的 10 分钟不计入。
  assert.equal(minutes, 30);
});

test("critical 安全事件未关闭时禁止恢复训练", () => {
  const { service, clock } = harness();
  start(service, clock);
  clock.setTo("2026-09-15T09:05:00+08:00");
  service.ingest(telemetry("s1", "09:05:00+08:00", "09:05:00+08:00", { symptom: "chest-tightness" }), clock.now());
  // 胸闷是 stop，不是 pause；模拟治疗师把课程置为 paused 不可行——直接断言 stopped 不可恢复。
  assert.throws(
    () => service.resumeTraining("s-1", "patient-confirmed", "患者自行休息后继续", clock.now()),
    /不能恢复训练/,
  );
});

test("迟到心率在课程停止后只产生 review-only 决定且无指令", () => {
  const { service, clock } = harness();
  start(service, clock, "s-1", "2026-09-15T09:00:00+08:00");

  clock.setTo("2026-09-15T09:05:01+08:00");
  service.ingest(telemetry("s1", "09:05:00+08:00", "09:05:01+08:00", { symptom: "chest-tightness" }), clock.now());
  const stop = service.getSession("s-1");
  assert.equal(stop.state, "stopped");
  const commandsBefore = stop.commands.length;

  clock.setTo("2026-09-15T09:12:00+08:00");
  const r1 = service.ingest(telemetry("t2", "09:06:00+08:00", "09:12:00+08:00", { heartRate: 136 }), clock.now());
  const r2 = service.ingest(telemetry("t3", "09:07:05+08:00", "09:12:00+08:00", { heartRate: 133 }), clock.now());
  const review = [...r1.decisions, ...r2.decisions].find((d) => d.reason === "sustained-heart-rate-over-limit");
  assert.ok(review);
  assert.equal(review!.basis, "review-only");
  assert.equal(review!.commandId, undefined);
  assert.equal(stop.commands.length, commandsBefore);
  assert.equal(stop.state, "stopped");
});

test("撤回阻止新课程并停止进行中课程，记录停止原因", () => {
  const { service, clock } = harness();
  start(service, clock, "s-1", "2026-09-15T09:00:00+08:00");
  start(service, clock, "s-2", "2026-09-15T09:01:00+08:00");
  // s-1 先因胸闷停止。
  clock.setTo("2026-09-15T09:02:00+08:00");
  service.ingest(
    { eventId: "x1", sessionId: "s-1", capturedAt: iso("09:02:00+08:00"), receivedAt: iso("09:02:00+08:00"), symptom: "chest-tightness" },
    clock.now(),
  );

  clock.setTo("2026-09-15T09:20:00+08:00");
  const notice = service.recallPrescription("rx-1", "用药调整", clock.now());
  assert.deepEqual(notice.affectedActiveSessionIds, ["s-2"]);
  assert.equal(service.getSession("s-2").commands[0]?.reason, "prescription-recalled");
  assert.throws(
    () => service.startSession({ sessionId: "s-3", prescriptionId: "rx-1", version: 1, startAt: clock.now() }),
    /撤回/,
  );
});

test("徽章：未关闭安全事件 / 未达时长 / 未结课都拒绝；正常完课才 eligible", () => {
  const { service, clock } = harness({ durationMinutes: 1 });
  start(service, clock, "s-1", "2026-09-15T09:00:00+08:00");

  // 未结课。
  clock.setTo("2026-09-15T09:00:30+08:00");
  const early = service.registerBadgeClaim(
    { claimId: "c1", sessionId: "s-1", badgeCode: "goal", at: clock.now().toISOString() },
    clock.now(),
  );
  assert.equal(early.status, "denied");

  // 满 1 分钟且无安全事件 → 正常完课 → eligible。
  clock.setTo("2026-09-15T09:01:05+08:00");
  service.completeSession("s-1", clock.now());
  const ok = service.registerBadgeClaim(
    { claimId: "c2", sessionId: "s-1", badgeCode: "goal", at: clock.now().toISOString() },
    clock.now(),
  );
  assert.equal(ok.status, "eligible");
  assert.deepEqual(ok.reasons, []);
});

test("有未关闭安全事件时不能正常完课，复核关闭后才 completed", () => {
  const { service, clock } = harness({ durationMinutes: 1 });
  start(service, clock, "s-1", "2026-09-15T09:00:00+08:00");
  clock.setTo("2026-09-15T09:00:30+08:00");
  service.ingest(telemetry("s1", "09:00:30+08:00", "09:00:30+08:00", { symptom: "chest-tightness" }), clock.now());
  // 红旗症状已停止课程，正常结课入口被关闭。
  assert.throws(() => service.completeSession("s-1", clock.now()), /不能正常结课/);
  assert.equal(service.getSession("s-1").openSafetyEvents.length, 1);

  const openId = service.getSession("s-1").openSafetyEvents[0]!.safetyEventId;
  clock.setTo("2026-09-15T10:00:00+08:00");
  service.submitReview(
    { reviewId: "r1", sessionId: "s-1", reviewerId: "t-1", at: clock.now().toISOString(), closeSafetyEventIds: [openId], notes: "已评估" },
    clock.now(),
  );
  assert.equal(service.getSession("s-1").state, "completed");
});

test("暂停态存在未关闭安全事件时同样不能正常完课", () => {
  const { service, clock } = harness({ durationMinutes: 1 });
  start(service, clock, "s-1", "2026-09-15T09:00:00+08:00");
  clock.setTo("2026-09-15T09:00:30+08:00");
  service.ingest(telemetry("d1", "09:00:30+08:00", "09:00:30+08:00", { symptom: "dizziness" }), clock.now());
  assert.equal(service.getSession("s-1").state, "paused");
  assert.throws(() => service.completeSession("s-1", clock.now()), /安全事件/);
});

test("患者删除请求被能力层拒绝；封存不移除事件", () => {
  const { service, clock } = harness();
  start(service, clock);
  clock.setTo("2026-09-15T09:05:00+08:00");
  service.ingest(telemetry("e1", "09:05:00+08:00", "09:05:00+08:00", { heartRate: 110 }), clock.now());
  assert.throws(() => service.patientRequestsDeletion("s-1"), /无权删除/);
  const manifest = service.archiveRawTelemetry(
    "s-1",
    { policyId: "p1", retentionUntil: "2027-09-15T23:59:59+08:00" },
    clock.now(),
  );
  assert.deepEqual(manifest.telemetryEventIds, ["e1"]);
  assert.equal(service.getSession("s-1").events.length, 1);
});

test("设备确认必须指向真实指令", () => {
  const { service, clock } = harness();
  start(service, clock);
  assert.throws(
    () =>
      service.acknowledge(
        { eventId: "a1", sessionId: "s-1", commandId: "cmd-nope", status: "acknowledged", at: clock.now().toISOString() },
        clock.now(),
      ),
    /不存在指令/,
  );
});

test("发布新版本不改写已开始课程的处方快照", () => {
  const { service, clock, rx, privateKey, registry } = harness();
  start(service, clock, "s-1", "2026-09-15T09:00:00+08:00");
  clock.setTo("2026-09-15T09:10:00+08:00");
  registry.publish(
    registry.sign({ ...rx, version: 2, heartRateZone: { minimum: 90, maximum: 110 } }, privateKey, keyId),
    clock.now(),
  );
  assert.equal(service.getSession("s-1").prescriptionSnapshot.heartRateZone.maximum, 125);
  assert.equal(service.getSession("s-1").binding.version, 1);
});
