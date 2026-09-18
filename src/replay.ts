import { strict as assert } from "node:assert";
import { RehabSafetyService } from "./service.ts";
import { loadRehabFixture, toTelemetry } from "./fixture.ts";

/**
 * 回放 fixtures/rehab-session.json：一次含断连、处方切换与胸闷上报的课程。
 * 预期看到：
 *   1) 胸闷先触发停止；
 *   2) 迟到心率只补充复核证据，不倒推实时指令；
 *   3) 旧处方版本不被新版本改写，课程固定引用开课版本；
 *   4) 从课程摘要可以追到每条安全决定。
 * 每个关键断言失败都会让脚本以非零码退出。
 */

const fixture = loadRehabFixture(new URL("../fixtures/rehab-session.json", import.meta.url));
const [t1, s1, t2] = [...fixture.events].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
assert.ok(t1 && s1 && t2, "样例应包含三条事件");
assert.equal(t1.heartRate, 112);
assert.equal(s1.symptom, "chest-tightness");
assert.equal(t2.heartRate, 136);

const RX = fixture.prescription.id;
const PATIENT = "patient-017";
const THERAPIST = "therapist-lu";
const log = (line: string) => console.log(line);

const service = new RehabSafetyService();

log("== 1. 处方生命周期：签署是下发的前提 ==");
service.prescriptions.submitDraft({
  prescriptionId: RX,
  version: fixture.prescription.version,
  patientId: PATIENT,
  validFrom: fixture.prescription.validFrom,
  validUntil: "2026-10-15T08:00:00+08:00",
  heartRateZone: { minimum: 90, maximum: 120 },
  durationMinutes: 30,
  contraindications: ["chest-tightness"],
});
assert.throws(
  () => service.sessions.startSession(PATIENT, RX, "rehab-early", "2026-09-15T09:00:00+08:00"),
  /没有已签署且有效/,
);
log(`   草稿 ${RX} v${fixture.prescription.version} 未签署时开课被拒绝 ✓`);
service.prescriptions.sign(RX, fixture.prescription.version, THERAPIST, "2026-09-15T08:30:00+08:00");
log(`   ${THERAPIST} 于 08:30 签署后下发 ✓`);

log("== 2. 开课：固定引用当次有效版本 ==");
const started = service.sessions.startSession(PATIENT, RX, fixture.sessionId, "2026-09-15T09:00:00+08:00");
assert.equal(started.prescriptionRef.version, fixture.prescription.version);
assert.equal(started.prescriptionRef.prescriptionId, RX);
log(`   课程 ${fixture.sessionId} 固定引用 ${RX} v${started.prescriptionRef.version}（90–120 bpm，30 分钟）✓`);

log("== 3. t1 到达（心率 112，在区间内）==");
service.sessions.ingestTelemetry(toTelemetry(t1, fixture.sessionId));
let summary = service.sessions.buildSummary(fixture.sessionId);
assert.equal(summary.state, "active");
assert.equal(summary.decisions.length, 0);
log("   心率 112 ≤ 120，继续训练，无安全决定 ✓");

log("== 4. 课程进行中发布新版本 v4（调药后收紧至 85–110）==");
service.prescriptions.submitDraft({
  prescriptionId: RX,
  version: 4,
  patientId: PATIENT,
  validFrom: "2026-09-15T09:06:00+08:00",
  validUntil: "2026-10-15T08:00:00+08:00",
  heartRateZone: { minimum: 85, maximum: 110 },
  durationMinutes: 30,
  contraindications: ["chest-tightness", "dizziness"],
});
service.prescriptions.sign(RX, 4, THERAPIST, "2026-09-15T09:06:30+08:00");
const v3Record = service.prescriptions.record(RX, 3);
assert.equal(v3Record.status, "signed");
assert.deepEqual(v3Record.draft.heartRateZone, { minimum: 90, maximum: 120 });
assert.equal(service.sessions.buildSummary(fixture.sessionId).prescriptionRef.version, 3);
const effectiveNow = service.prescriptions.activeVersionAt(RX, "2026-09-15T09:07:00+08:00");
assert.ok(effectiveNow);
assert.equal(effectiveNow.draft.version, 4);
log("   v3 记录未被改写；进行中的课程仍按 v3 评估；此刻新开课程才会引用 v4 ✓");

log("== 5. s1 到达（胸闷上报）→ 先触发停止 ==");
service.sessions.ingestTelemetry(toTelemetry(s1, fixture.sessionId));
summary = service.sessions.buildSummary(fixture.sessionId);
assert.equal(summary.state, "under-review");
assert.equal(summary.decisions.length, 1);
const stopDecision = summary.decisions[0];
assert.ok(stopDecision);
assert.equal(stopDecision.action, "stop");
assert.equal(stopDecision.rule, "stop-symptom");
assert.deepEqual(stopDecision.evidenceEventIds, ["s1"]);
assert.equal(stopDecision.decidedAt, s1.receivedAt, "决定时间必须是到达时间，不能倒推到采集时间");
assert.equal(summary.commands.length, 1);
const stopCommand = summary.commands[0];
assert.ok(stopCommand);
assert.equal(stopCommand.kind, "stop");
assert.equal(stopCommand.issuedAt, s1.receivedAt);
log(`   ${stopDecision.decidedAt} [${stopDecision.rule}] stop，指令 ${stopCommand.commandId} 已下发，证据=[s1] ✓`);
log(`   注意：t2（136 bpm）此刻尚未到达，停止完全由症状规则触发`);

log("== 6. 设备确认停止、患者请求帮助，进入同一课程记录 ==");
service.sessions.acknowledgeCommand(fixture.sessionId, stopCommand.commandId, "watch-7", "2026-09-15T09:08:15+08:00");
service.sessions.recordDeviceBadge(fixture.sessionId, "device-goal-reached", "2026-09-15T09:10:00+08:00");
service.sessions.requestHelp(fixture.sessionId, "2026-09-15T09:09:05+08:00", "患者仍感胸闷，请求协助");
summary = service.sessions.buildSummary(fixture.sessionId);
assert.equal(summary.acknowledgments.length, 1);
assert.equal(summary.helpRequests.length, 1);
assert.equal(summary.decisions.length, 2);
assert.equal(summary.decisions[1]?.rule, "patient-help-request");
assert.equal(summary.safetyEvents[0]?.decisionIds.length, 2);
log("   设备确认、设备达标徽章（仅记录）、患者求助均已入档，求助升级为 seek-help 决定 ✓");

log("== 7. t2 迟到到达（断连补传：09:07 采集，09:12 才到）==");
const commandsBefore = summary.commands.length;
service.sessions.ingestTelemetry(toTelemetry(t2, fixture.sessionId));
summary = service.sessions.buildSummary(fixture.sessionId);
assert.equal(summary.commands.length, commandsBefore, "迟到数据不得触发新的实时指令");
assert.equal(summary.decisions.length, 2, "已有未关闭安全事件时，迟到数据不产生新决定");
assert.deepEqual(summary.lateEventIds, ["t2"]);
assert.deepEqual(summary.safetyEvents[0]?.evidenceEventIds, ["s1", "t2"]);
log("   136 bpm 虽超限，但只作为复核证据并入安全事件，未倒推任何实时指令 ✓");

log("== 8. 安全事件未关闭 → 完成徽章被拒绝 ==");
assert.throws(() => service.sessions.tryAwardBadge(fixture.sessionId, "2026-09-15T09:12:30+08:00"), /未关闭安全事件/);
log("   即使设备已发达标徽章，完成徽章仍被临床安全限制拦截 ✓");

log("== 9. 治疗师复核：迟到心率成为复核证据 ==");
const incidentId = summary.safetyEvents[0]?.safetyEventId;
assert.ok(incidentId);
service.sessions.review(
  fixture.sessionId,
  incidentId,
  THERAPIST,
  "closed",
  "2026-09-15T10:00:00+08:00",
  "迟到的 136 bpm 证实超限先于症状出现，维持停止决定，安排复诊调整方案",
);
summary = service.sessions.buildSummary(fixture.sessionId);
assert.equal(summary.safetyEvents[0]?.status, "closed");
assert.equal(summary.safetyEvents[0]?.closedByReviewId, summary.reviews[0]?.reviewId);
assert.equal(summary.state, "stopped");
log(`   复核关闭 ${incidentId}，证据链 [s1, t2] 完整保留，课程定格 stopped ✓`);

log("== 10. 原始遥测：患者不能删除，只能按保留策略封存 ==");
const deletion = service.sessions.requestTelemetryDeletion(fixture.sessionId, ["t2"], PATIENT, "2026-09-15T10:05:00+08:00");
assert.equal(deletion.accepted, false);
assert.equal(service.sessions.telemetryOf(fixture.sessionId).length, 3);
const archive = service.sessions.archiveTelemetry(fixture.sessionId, 180, "2026-09-15T10:06:00+08:00");
assert.equal(archive.eventCount, 3);
log(`   删除请求被拒绝并留痕；遥测已封存至 ${archive.retentionUntil} ✓`);

summary = service.sessions.buildSummary(fixture.sessionId);
log("\n== 课程摘要：每条安全决定的追溯链 ==");
for (const d of summary.decisions) {
  log(`   ${d.decidedAt}  ${d.decisionId}  [${d.rule}] ${d.action}`);
  log(`      证据=[${d.evidenceEventIds.join(", ") || "-"}]  指令=${d.commandId ?? "-"}  ${d.reason}`);
}
log("\n完整摘要 JSON：");
console.log(JSON.stringify(summary, null, 2));
log("\n回放完成：全部断言通过 ✓");
