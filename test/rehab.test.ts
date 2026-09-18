import test from "node:test";
import { strict as assert } from "node:assert";
import { RehabSafetyService } from "../src/service.ts";
import { loadRehabFixture, toTelemetry } from "../src/fixture.ts";
import type { PrescriptionDraft, TelemetryEvent } from "../src/contracts.ts";

const RX_BASE: PrescriptionDraft = {
  prescriptionId: "rx-1",
  version: 1,
  patientId: "p-1",
  validFrom: "2026-09-01T00:00:00+08:00",
  validUntil: "2026-10-01T00:00:00+08:00",
  heartRateZone: { minimum: 90, maximum: 120 },
  durationMinutes: 30,
  contraindications: ["chest-tightness"],
};

function signedService(): RehabSafetyService {
  const service = new RehabSafetyService();
  service.prescriptions.submitDraft(RX_BASE);
  service.prescriptions.sign("rx-1", 1, "dr-a", "2026-09-01T01:00:00+08:00");
  return service;
}

/** 每个测试用独立计数器生成事件 ID，便于断言证据链。 */
function eventFactory(sessionId: string) {
  let n = 0;
  return {
    hr(capturedAt: string, heartRate: number, receivedAt?: string): TelemetryEvent {
      n += 1;
      return { eventId: `e${n}`, sessionId, capturedAt, receivedAt: receivedAt ?? capturedAt, heartRate };
    },
    symptom(capturedAt: string, symptom: string, receivedAt?: string): TelemetryEvent {
      n += 1;
      return { eventId: `e${n}`, sessionId, capturedAt, receivedAt: receivedAt ?? capturedAt, symptom };
    },
  };
}

const at = (base: string, plusSeconds: number): string =>
  new Date(Date.parse(base) + plusSeconds * 1000).toISOString();

test("处方必须签署后才能下发开课", () => {
  const service = new RehabSafetyService();
  service.prescriptions.submitDraft(RX_BASE);
  assert.throws(
    () => service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00"),
    /没有已签署且有效/,
  );
  service.prescriptions.sign("rx-1", 1, "dr-a", "2026-09-01T01:00:00+08:00");
  const started = service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");
  assert.equal(started.prescriptionRef.version, 1);
  assert.equal(started.state, "active");
});

test("开课固定引用当次版本，新版本不改写旧版本", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");

  service.prescriptions.submitDraft({
    ...RX_BASE,
    version: 2,
    heartRateZone: { minimum: 80, maximum: 100 },
    validFrom: "2026-09-10T09:30:00+08:00",
  });
  service.prescriptions.sign("rx-1", 2, "dr-a", "2026-09-10T09:31:00+08:00");

  // 旧版本记录保持原样
  const v1 = service.prescriptions.record("rx-1", 1);
  assert.equal(v1.status, "signed");
  assert.deepEqual(v1.draft.heartRateZone, { minimum: 90, maximum: 120 });

  // 进行中的课程仍按 v1 评估：110 在 v1 区间内（v2 上限 100 会超限）
  const ev = eventFactory("s-1");
  service.sessions.ingestTelemetry(ev.hr("2026-09-10T09:35:00+08:00", 110));
  assert.equal(service.sessions.buildSummary("s-1").decisions.length, 0);
  assert.equal(service.sessions.buildSummary("s-1").prescriptionRef.version, 1);

  // 新开课程引用当次有效版本 v2
  const s2 = service.sessions.startSession("p-1", "rx-1", "s-2", "2026-09-10T10:00:00+08:00");
  assert.equal(s2.prescriptionRef.version, 2);

  // 已签署版本不能被重写或重复签署
  assert.throws(() => service.prescriptions.submitDraft({ ...RX_BASE, version: 1 }), /已存在|递增/);
  assert.throws(() => service.prescriptions.sign("rx-1", 1, "dr-b", "2026-09-10T10:00:00+08:00"), /不能改写/);
});

test("撤回只阻止新课程，并向进行中的课程发出停止原因", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-active", "2026-09-10T09:00:00+08:00");
  service.sessions.startSession("p-1", "rx-1", "s-stopped", "2026-09-10T09:00:00+08:00");
  const ev = eventFactory("s-stopped");
  service.sessions.ingestTelemetry(ev.symptom("2026-09-10T09:05:00+08:00", "chest-tightness"));
  assert.equal(service.sessions.buildSummary("s-stopped").commands.length, 1);

  const affected = service.withdrawPrescription("rx-1", 1, "药物方案调整", "2026-09-10T09:30:00+08:00");
  assert.deepEqual(affected, ["s-active"]);

  const active = service.sessions.buildSummary("s-active");
  assert.equal(active.state, "under-review");
  assert.equal(active.endedAs, "stopped");
  const stopCommand = active.commands.find((c) => c.kind === "stop");
  assert.ok(stopCommand);
  assert.match(stopCommand.reason, /处方撤回/);
  assert.equal(active.decisions.at(-1)?.rule, "prescription-withdrawn");

  // 已结束的课程不再收到新指令，记录保持原样
  assert.equal(service.sessions.buildSummary("s-stopped").commands.length, 1);

  // 撤回后不能开新课；处方记录本身保留为 withdrawn
  assert.throws(() => service.sessions.startSession("p-1", "rx-1", "s-late", "2026-09-10T09:40:00+08:00"));
  assert.equal(service.prescriptions.record("rx-1", 1).status, "withdrawn");
});

test("回放样例：胸闷先触发停止，迟到心率只补充复核证据", () => {
  const fixture = loadRehabFixture(new URL("../fixtures/rehab-session.json", import.meta.url));
  const service = new RehabSafetyService();
  service.prescriptions.submitDraft({
    prescriptionId: fixture.prescription.id,
    version: fixture.prescription.version,
    patientId: "p-1",
    validFrom: fixture.prescription.validFrom,
    validUntil: "2026-10-15T08:00:00+08:00",
    heartRateZone: { minimum: 90, maximum: 120 },
    durationMinutes: 30,
    contraindications: ["chest-tightness"],
  });
  service.prescriptions.sign(fixture.prescription.id, fixture.prescription.version, "dr-a", "2026-09-15T08:30:00+08:00");
  service.sessions.startSession("p-1", fixture.prescription.id, fixture.sessionId, "2026-09-15T09:00:00+08:00");

  const byArrival = [...fixture.events].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const [t1, s1, t2] = byArrival;
  assert.ok(t1 && s1 && t2);

  service.sessions.ingestTelemetry(toTelemetry(t1, fixture.sessionId));
  assert.equal(service.sessions.buildSummary(fixture.sessionId).decisions.length, 0);

  // 胸闷先触发停止（t2 尚未到达）
  service.sessions.ingestTelemetry(toTelemetry(s1, fixture.sessionId));
  let summary = service.sessions.buildSummary(fixture.sessionId);
  assert.equal(summary.decisions.length, 1);
  assert.equal(summary.decisions[0]?.action, "stop");
  assert.equal(summary.decisions[0]?.rule, "stop-symptom");
  assert.equal(summary.decisions[0]?.decidedAt, s1.receivedAt);
  assert.deepEqual(summary.decisions[0]?.evidenceEventIds, ["s1"]);
  assert.equal(summary.commands.length, 1);

  // 迟到心率只补充复核证据：无新指令、无新决定
  service.sessions.ingestTelemetry(toTelemetry(t2, fixture.sessionId));
  summary = service.sessions.buildSummary(fixture.sessionId);
  assert.equal(summary.commands.length, 1);
  assert.equal(summary.decisions.length, 1);
  assert.deepEqual(summary.lateEventIds, ["t2"]);
  assert.deepEqual(summary.safetyEvents[0]?.evidenceEventIds, ["s1", "t2"]);
});

test("心率持续超限触发暂停，恢复过慢升级为求助并终止", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");
  const ev = eventFactory("s-1");
  const t0 = "2026-09-10T09:00:00+08:00";

  service.sessions.ingestTelemetry(ev.hr(at(t0, 0), 130));
  service.sessions.ingestTelemetry(ev.hr(at(t0, 30), 135));
  assert.equal(service.sessions.buildSummary("s-1").state, "active", "未满 60 秒不判定持续超限");

  service.sessions.ingestTelemetry(ev.hr(at(t0, 70), 133));
  let summary = service.sessions.buildSummary("s-1");
  assert.equal(summary.state, "paused");
  assert.equal(summary.decisions[0]?.rule, "sustained-over-limit");
  assert.equal(summary.decisions[0]?.action, "pause");
  assert.deepEqual(summary.decisions[0]?.evidenceEventIds, ["e1", "e2", "e3"]);
  assert.equal(summary.commands[0]?.kind, "pause");

  // 暂停 130 秒后心率仅降 3 bpm（要求 ≥ 12）→ 求助并终止
  service.sessions.ingestTelemetry(ev.hr(at(t0, 200), 130));
  summary = service.sessions.buildSummary("s-1");
  assert.equal(summary.decisions[1]?.rule, "recovery-too-slow");
  assert.equal(summary.decisions[1]?.action, "seek-help");
  assert.equal(summary.commands[1]?.kind, "stop");
  assert.equal(summary.state, "under-review");
});

test("超限暂停后心率回到区间内可继续，未列入停止清单的症状谨慎暂停", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");
  const ev = eventFactory("s-1");
  const t0 = "2026-09-10T09:00:00+08:00";

  service.sessions.ingestTelemetry(ev.hr(at(t0, 0), 130));
  service.sessions.ingestTelemetry(ev.hr(at(t0, 90), 134));
  assert.equal(service.sessions.buildSummary("s-1").state, "paused");

  service.sessions.ingestTelemetry(ev.hr(at(t0, 120), 118));
  let summary = service.sessions.buildSummary("s-1");
  assert.equal(summary.state, "active");
  assert.equal(summary.decisions.at(-1)?.rule, "recovered-to-zone");
  assert.equal(summary.decisions.at(-1)?.action, "continue");

  service.sessions.ingestTelemetry(ev.symptom(at(t0, 150), "mild-fatigue"));
  summary = service.sessions.buildSummary("s-1");
  assert.equal(summary.state, "paused");
  assert.equal(summary.decisions.at(-1)?.rule, "symptom-caution");
  assert.equal(summary.decisions.at(-1)?.action, "pause");
});

test("安全事件关闭前不能生成完成徽章，设备徽章不具备临床效力", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");
  const ev = eventFactory("s-1");
  const t0 = "2026-09-10T09:00:00+08:00";

  // 一次超限暂停后恢复，随后设备上报达标徽章
  service.sessions.ingestTelemetry(ev.hr(at(t0, 0), 130));
  service.sessions.ingestTelemetry(ev.hr(at(t0, 90), 134));
  service.sessions.ingestTelemetry(ev.hr(at(t0, 120), 118));
  service.sessions.recordDeviceBadge("s-1", "device-goal-reached", at(t0, 130));

  // 达到处方时长结束课程：事件未关闭 → under-review，徽章被拒
  service.sessions.finishSession("s-1", at(t0, 31 * 60));
  assert.equal(service.sessions.buildSummary("s-1").state, "under-review");
  assert.throws(() => service.sessions.tryAwardBadge("s-1", at(t0, 31 * 60 + 5)), /未关闭安全事件/);

  // 治疗师复核关闭后才能生成徽章
  const incidentId = service.sessions.buildSummary("s-1").safetyEvents[0]?.safetyEventId;
  assert.ok(incidentId);
  service.sessions.review("s-1", incidentId, "dr-a", "closed", at(t0, 32 * 60));
  assert.equal(service.sessions.buildSummary("s-1").state, "completed");
  const badge = service.sessions.tryAwardBadge("s-1", at(t0, 32 * 60 + 5));
  assert.ok(badge.badgeId);
  assert.equal(service.sessions.tryAwardBadge("s-1", at(t0, 33 * 60)).badgeId, badge.badgeId, "徽章幂等");
});

test("原始遥测不能由患者删除，只能按保留策略封存", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");
  const ev = eventFactory("s-1");
  service.sessions.ingestTelemetry(ev.hr("2026-09-10T09:05:00+08:00", 110));

  const result = service.sessions.requestTelemetryDeletion("s-1", ["e1"], "p-1", "2026-09-10T09:10:00+08:00");
  assert.equal(result.accepted, false);
  assert.equal(service.sessions.telemetryOf("s-1").length, 1, "遥测仍在");

  const archive = service.sessions.archiveTelemetry("s-1", 90, "2026-09-10T09:20:00+08:00");
  assert.equal(archive.eventCount, 1);
  assert.ok(Date.parse(archive.retentionUntil) > Date.parse(archive.sealedAt));

  const summary = service.sessions.buildSummary("s-1");
  assert.equal(summary.deletionAttempts.length, 1);
  assert.equal(summary.deletionAttempts[0]?.outcome, "rejected");
  assert.equal(summary.archives.length, 1);
});

test("设备确认、患者求助与治疗师复核都进入同一课程记录", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");
  const ev = eventFactory("s-1");

  service.sessions.ingestTelemetry(ev.symptom("2026-09-10T09:05:00+08:00", "chest-tightness"));
  let summary = service.sessions.buildSummary("s-1");
  const commandId = summary.commands[0]?.commandId;
  const incidentId = summary.safetyEvents[0]?.safetyEventId;
  assert.ok(commandId && incidentId);

  service.sessions.acknowledgeCommand("s-1", commandId, "watch-1", "2026-09-10T09:05:20+08:00");
  service.sessions.requestHelp("s-1", "2026-09-10T09:06:00+08:00", "患者要求联系治疗师");
  service.sessions.review("s-1", incidentId, "dr-a", "closed", "2026-09-10T10:00:00+08:00", "电话随访无异常");

  summary = service.sessions.buildSummary("s-1");
  assert.equal(summary.acknowledgments.length, 1);
  assert.equal(summary.acknowledgments[0]?.sessionId, "s-1");
  assert.equal(summary.helpRequests.length, 1);
  assert.equal(summary.reviews.length, 1);
  assert.equal(summary.safetyEvents[0]?.status, "closed");
  assert.deepEqual(summary.safetyEvents[0]?.decisionIds, ["dec-1", "dec-2"]);
  assert.equal(summary.state, "stopped");
});

test("课程结束后到达的迟到超限数据只登记复核，不发设备指令", () => {
  const service = signedService();
  service.sessions.startSession("p-1", "rx-1", "s-1", "2026-09-10T09:00:00+08:00");
  const ev = eventFactory("s-1");
  const t0 = "2026-09-10T09:00:00+08:00";

  service.sessions.ingestTelemetry(ev.hr(at(t0, 60), 110));
  service.sessions.finishSession("s-1", at(t0, 31 * 60));
  assert.equal(service.sessions.buildSummary("s-1").state, "completed");

  // 断连补传：课程中某时刻心率 150，课程结束后才到达
  service.sessions.ingestTelemetry(ev.hr(at(t0, 300), 150, at(t0, 32 * 60)));
  const summary = service.sessions.buildSummary("s-1");
  assert.equal(summary.commands.length, 0, "不倒推实时指令");
  assert.deepEqual(summary.lateEventIds, ["e2"]);
  assert.equal(summary.decisions.at(-1)?.rule, "late-evidence-violation");
  assert.equal(summary.decisions.at(-1)?.action, "seek-help");
  assert.equal(summary.state, "under-review");
  assert.throws(() => service.sessions.tryAwardBadge("s-1", at(t0, 33 * 60)), /未关闭安全事件/);
});
