/**
 * 回放 fixtures/rehab-session.json 的完整课程。
 *
 * 按 receivedAt 单调推进服务器时钟，重放开课、断连、胸闷实时停止、迟到补传、
 * 处方新版本发布、撤回、设备确认、求助、复核、徽章裁决与封存，并对关键安全不变量做断言。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ClinicianReview,
  DeviceAcknowledgement,
  DeviceBadgeClaim,
  HelpRequest,
  PrescriptionVersion,
  TelemetryEvent,
} from "./contracts.js";
import { ManualClock } from "./clock.js";
import { PrescriptionRegistry, TherapistKeyring } from "./prescription.js";
import { SessionService } from "./session-service.js";
import { buildSummary } from "./summary.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "rehab-session.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, any>;

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function toRx(raw: Record<string, unknown>): PrescriptionVersion {
  return {
    prescriptionId: raw.prescriptionId as string,
    version: raw.version as number,
    patientId: raw.patientId as string,
    validFrom: raw.validFrom as string,
    validUntil: raw.validUntil as string,
    heartRateZone: raw.heartRateZone as PrescriptionVersion["heartRateZone"],
    durationMinutes: raw.durationMinutes as number,
    contraindications: raw.contraindications as string[],
    signedBy: raw.signedBy as string,
  };
}

async function main(): Promise<void> {
  const keyId = "therapist-7-ed25519";
  const { keyring, privateKey } = TherapistKeyring.generateDemoKey(keyId);
  const registry = new PrescriptionRegistry(keyring);
  const service = new SessionService(registry);
  const clock = new ManualClock("2026-09-15T08:00:00+08:00");

  // 签名并登记处方：v2（上周，已过期）、v3（当次有效）。v4 在开课后才发布。
  const prescriptions = new Map<number, PrescriptionVersion>();
  for (const raw of fixture.prescriptions as Array<Record<string, unknown>>) {
    const rx = toRx(raw);
    prescriptions.set(rx.version, rx);
    if (rx.version !== 4) {
      clock.setTo("2026-09-15T08:05:00+08:00");
      const signed = registry.sign(rx, privateKey, keyId);
      registry.publish(signed, clock.now());
    }
  }
  const rx3 = prescriptions.get(3)!;

  // 篡改签名必须被拒绝（用 v3 的签名配一个被改动的区间）。
  let tamperRejected = false;
  try {
    const signed3 = registry.sign(rx3, privateKey, keyId);
    registry.publish(
      { ...signed3, prescription: { ...rx3, heartRateZone: { minimum: 95, maximum: 200 } } },
      clock.now(),
    );
  } catch {
    tamperRejected = true;
  }

  // 平行课程 rehab-33 先开课（09:03），撤回演示用。
  const ps = fixture.parallelSession as Record<string, unknown>;
  clock.setTo(ps.startAt as string);
  service.startSession({
    sessionId: ps.sessionId as string,
    prescriptionId: "rx-8",
    version: 3,
    startAt: clock.now(),
  });

  // 开课：rehab-32 固定 v3（09:04），腕表自报上周 v2 区间。
  const start = fixture.session as Record<string, unknown>;
  clock.setTo(start.startAt as string);
  const session = service.startSession({
    sessionId: start.sessionId as string,
    prescriptionId: start.prescriptionId as string,
    version: start.version as number,
    startAt: clock.now(),
    deviceReportedZone: start.deviceReportedZone as PrescriptionVersion["heartRateZone"],
  });
  const boundFingerprint = session.binding.fingerprint;

  console.log("\n=== 1. 开课绑定 ===");
  check("课程固定引用签署处方 rx-8 v3", session.binding.version === 3);
  check("检测到腕表仍按上周 v2 区间（100-140）训练并留痕", session.binding.zoneMismatch === true);
  check("篡改/错签处方被拒绝下发", tamperRejected);

  // 按 receivedAt 依次推进。
  console.log("\n=== 2. 实时事件流（服务器时钟只进不退）===");

  // 平行课程的遥测先入库（09:06:02），使 rehab-33 成为真实进行中课程。
  const ptelemetry = (ps.telemetry as Array<Record<string, unknown>>).map((e) => ({
    eventId: e.eventId as string,
    sessionId: ps.sessionId as string,
    capturedAt: e.capturedAt as string,
    receivedAt: e.receivedAt as string,
    ...(e.heartRate !== undefined ? { heartRate: e.heartRate as number } : {}),
    ...(e.symptom !== undefined ? { symptom: e.symptom as string } : {}),
  }));

  const sessionId = session.sessionId;
  const rawEvents = [...(fixture.events as Array<Record<string, unknown>>)]
    .sort((a, b) => new Date(a.receivedAt as string).getTime() - new Date(b.receivedAt as string).getTime());
  // 只取契约字段（fixture 中的 note 等说明性字段不进入临床记录）。
  const events: TelemetryEvent[] = rawEvents.map((e) => ({
    eventId: e.eventId as string,
    sessionId,
    capturedAt: e.capturedAt as string,
    receivedAt: e.receivedAt as string,
    ...(e.heartRate !== undefined ? { heartRate: e.heartRate as number } : {}),
    ...(e.symptom !== undefined ? { symptom: e.symptom as string } : {}),
  }));
  const t1 = events[0]!;
  const s1 = events[1]!;
  const t2 = events[2]!;
  const t2b = events[3]!;

  clock.setTo(t1.receivedAt);
  const r1 = service.ingest(t1, clock.now());
  check("t1 心率 112 在 v3 区间 95-125 内 → continue", r1.decisions[0]?.action === "continue");

  // 平行课程 09:06 的遥测入库（与主课程互不干扰）。
  clock.setTo(ptelemetry[0]!.receivedAt);
  service.ingest(ptelemetry[0]!, clock.now());

  clock.setTo(s1.receivedAt);
  const rs1 = service.ingest(s1, clock.now());
  const stopDecision = rs1.decisions.find((d) => d.action === "stop");
  const stopCommand = rs1.command;
  check(
    "胸闷 s1 立即触发 STOP（先于一切数值规则）",
    stopDecision?.reason === "contraindicated-symptom" && stopCommand?.action === "stop",
  );
  check(
    "停止指令 issuedAt 取服务器处理时间 09:08:01，而非症状采集时间 09:08:00，更不倒推",
    stopCommand?.issuedAt === new Date(s1.receivedAt).toISOString(),
    stopCommand?.issuedAt,
  );
  check("同时给出 seek-help 决定", rs1.decisions.some((d) => d.action === "seek-help"));
  check("课程状态已变为 stopped", service.getSession("rehab-32").state === "stopped");

  // 设备确认停止。
  const acks = fixture.deviceAcknowledgements as DeviceAcknowledgement[];
  const a1 = acks[0]!;
  clock.setTo(a1.at);
  service.acknowledge(
    {
      eventId: a1.eventId,
      sessionId: session.sessionId,
      commandId: stopCommand!.commandId,
      status: a1.status,
      at: a1.at,
      ...(a1.detail ? { detail: a1.detail } : {}),
    },
    clock.now(),
  );
  check("设备停止确认进入同一课程记录", session.acknowledgements[0]?.eventId === "a1");

  // 患者求助。
  const h1 = (fixture.helpRequests as HelpRequest[])[0]!;
  clock.setTo(h1.at);
  service.requestHelp({ eventId: h1.eventId, sessionId: session.sessionId, at: h1.at, ...(h1.message ? { message: h1.message } : {}) }, clock.now());
  check("患者求助进入同一课程记录并生成 seek-help 决定", session.helpRequests[0]?.eventId === "h1");

  console.log("\n=== 3. 课程进行中发布 v4：不得改写 ===");
  const rx4 = toRx((fixture.prescriptions as Array<Record<string, unknown>>)[2]!);
  clock.setTo(rx4.validFrom);
  registry.publish(registry.sign(rx4, privateKey, keyId), clock.now());
  check("v4 已登记可用于后续新课程", (() => {
    try {
      registry.getSigned("rx-8", 4);
      return true;
    } catch {
      return false;
    }
  })());
  check("rehab-32 绑定指纹未变", session.binding.fingerprint === boundFingerprint);
  check(
    "课程快照仍是 v3（上限 125），未被 v4（上限 110）改写",
    session.prescriptionSnapshot.heartRateZone.maximum === 125 &&
      session.prescriptionSnapshot.version === 3,
  );

  console.log("\n=== 4. 断连恢复，迟到心率补传：只补充复核 ===");
  clock.setTo(t2.receivedAt); // 09:12
  service.ingest(t2, clock.now());
  const rLate = service.ingest(t2b, clock.now());
  const reviewDecision = rLate.decisions.find((d) => d.reason === "sustained-heart-rate-over-limit");
  check(
    "迟到证据 t2+t2b 按 capturedAt 构成持续超限（09:07→09:08:05，65 秒）",
    reviewDecision !== undefined,
  );
  check("该决定 basis=review-only", reviewDecision?.basis === "review-only");
  check("未因迟到数据补发任何实时指令（无 commandId）", reviewDecision?.commandId === undefined);
  check("课程状态保持 stopped", session.state === "stopped");
  check(
    "证据时间窗保留临床时间（09:07-09:08:05），决定时间是处理时间（09:12）",
    reviewDecision?.evidenceCapturedFrom === t2.capturedAt &&
      reviewDecision?.decidedAt === new Date(t2.receivedAt).toISOString(),
  );

  console.log("\n=== 5. 设备达标徽章声称：安全限制优先 ===");
  const claims = fixture.badgeClaims as DeviceBadgeClaim[];
  clock.setTo(claims[0]!.at);
  const badge1 = service.registerBadgeClaim(claims[0]!, clock.now());
  check("安全事件未关闭时徽章被拒", badge1.status === "denied");
  check(
    "拒绝理由同时包含未关闭安全事件",
    badge1.reasons.some((r) => r.includes("安全事件")),
  );

  console.log("\n=== 6. 撤回处方：只阻止新课程 + 停止进行中课程 ===");
  const recall = fixture.recall as { reason: string; at: string };
  clock.setTo(recall.at);
  const notice = service.recallPrescription("rx-8", recall.reason, clock.now());
  check("撤回只影响进行中的 rehab-33", notice.affectedActiveSessionIds.join(",") === "rehab-33");
  check("已停止的 rehab-32 不被撤回追加停止指令", !notice.affectedActiveSessionIds.includes("rehab-32"));
  check("rehab-33 收到 prescription-recalled 停止指令", service.getSession("rehab-33").commands[0]?.reason === "prescription-recalled");

  const pa = (ps.acknowledgement as DeviceAcknowledgement);
  clock.setTo(pa.at);
  service.acknowledge(
    {
      eventId: pa.eventId,
      sessionId: "rehab-33",
      commandId: service.getSession("rehab-33").commands[0]!.commandId,
      status: pa.status,
      at: pa.at,
    },
    clock.now(),
  );

  let newSessionBlocked = false;
  try {
    service.startSession({
      sessionId: "rehab-34",
      prescriptionId: "rx-8",
      version: 3,
      startAt: clock.now(),
    });
  } catch {
    newSessionBlocked = true;
  }
  check("撤回后无法用 rx-8 开始新课程", newSessionBlocked);

  console.log("\n=== 7. 治疗师复诊复核：关闭安全事件的唯一途径 ===");
  const rv = fixture.review as ClinicianReview;
  const openIds = service.getSession("rehab-32").openSafetyEvents.map((e) => e.safetyEventId);
  clock.setTo(rv.at);
  service.submitReview(
    {
      reviewId: rv.reviewId,
      sessionId: rv.sessionId,
      reviewerId: rv.reviewerId,
      at: rv.at,
      closeSafetyEventIds: openIds,
      notes: rv.notes,
    },
    clock.now(),
  );
  check("全部安全事件关闭", service.getSession("rehab-32").openSafetyEvents.length === 0);
  check("课程进入 completed", service.getSession("rehab-32").state === "completed");

  console.log("\n=== 8. 关闭后重试徽章与原始遥测封存 ===");
  clock.setTo(claims[1]!.at);
  const badge2 = service.registerBadgeClaim(claims[1]!, clock.now());
  check("安全事件关闭后徽章仍被拒", badge2.status === "denied");
  check(
    "拒绝理由转为有效时长不足（停止后继续训练不计入）",
    badge2.reasons.some((r) => r.includes("未达处方目标")),
    badge2.reasons.join("；"),
  );

  const retention = fixture.retention as { policyId: string; sealAt: string; retentionUntil: string };
  clock.setTo(retention.sealAt);
  const manifest = service.archiveRawTelemetry(
    "rehab-32",
    { policyId: retention.policyId, retentionUntil: retention.retentionUntil },
    clock.now(),
  );
  check("原始遥测按保留策略封存（含全部 4 条事件指纹）", manifest.telemetryEventIds.length === 4);

  let deletionBlocked = false;
  try {
    service.patientRequestsDeletion("rehab-32");
  } catch (error) {
    deletionBlocked = true;
    console.log(`     患者删除请求被拒：${(error as Error).message}`);
  }
  check("患者无法删除原始遥测，只能封存", deletionBlocked);

  // 汇总与追溯。
  const summary = buildSummary(service.getSession("rehab-32"));
  check("课程记录哈希链完整可验", summary.chainValid);

  console.log("\n=== 9. 课程摘要 → 每条安全决定追溯 ===");
  console.log(formatSummary(summary));

  console.log("\n=== 10. 记录防篡改 ===");
  const log = service.getSession("rehab-32").log;
  const t1Entry = log.byType("telemetry").find((e) => e.data.eventId === "t1")!;
  const originalHeartRate = t1Entry.data.heartRate!;
  let tamperDetected = false;
  // 即使有人直接改底层记录（例如想把 112 改成“区间内更安全”的值），哈希链立即失效。
  t1Entry.data.heartRate = 100;
  try {
    log.verifyChain();
  } catch (error) {
    tamperDetected = true;
    console.log(`     篡改被发现：${(error as Error).message}`);
  }
  t1Entry.data.heartRate = originalHeartRate;
  log.verifyChain(); // 恢复后链重新有效
  check("任何对已入库遥测的改动都会被哈希链发现", tamperDetected);
  check("恢复原值后哈希链重新通过", true);

  if (failures > 0) {
    console.error(`\n回放断言失败 ${failures} 项`);
    process.exitCode = 1;
  } else {
    console.log("\n🎉 全部安全不变量验证通过");
  }
}

function fmtLocal(iso: string): string {
  // 统一按课程所在时区显示（sv-SE 给出 ISO 风格 "YYYY-MM-DD HH:mm:ss"）。
  return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function formatSummary(s: ReturnType<typeof buildSummary>): string {
  const lines: string[] = [];
  lines.push(`课程 ${s.sessionId}  状态=${s.state}  处方=${s.boundPrescription.prescriptionId} v${s.boundPrescription.version}`);
  lines.push(
    `签署区间 ${s.boundPrescription.zone.minimum}-${s.boundPrescription.zone.maximum} bpm` +
      (s.boundPrescription.zoneMismatch
        ? `（腕表自报 ${s.boundPrescription.deviceReportedZone!.minimum}-${s.boundPrescription.deviceReportedZone!.maximum}，不一致已留痕）`
        : ""),
  );
  lines.push(
    `记录计数：遥测 ${s.counts.telemetry} / 决定 ${s.counts.decisions} / 指令 ${s.counts.commands} / 设备确认 ${s.counts.acknowledgements} / 求助 ${s.counts.helpRequests} / 复核 ${s.counts.reviews} / 安全事件 ${s.counts.safetyEventsTotal}（未关闭 ${s.counts.safetyEventsOpen}）`,
  );
  lines.push("安全决定时间线：");
  for (const d of s.decisions) {
    if (d.reason === "within-limits") continue;
    const ev = d.evidence
      .map((e) =>
        e.eventId === "(非遥测)" || e.capturedAt === "(非遥测)"
          ? e.eventId
          : `${e.eventId}[采集 ${fmtLocal(e.capturedAt).slice(11)}/收到 ${fmtLocal(e.receivedAt).slice(11)} 延迟 ${e.latencyMs / 1000}s${e.heartRate !== undefined ? ` ${e.heartRate}bpm` : ""}${e.symptom !== undefined ? ` ${e.symptom}` : ""}]`,
      )
      .join(" ");
    lines.push(
      `  · ${fmtLocal(d.decidedAt).slice(11)} ${d.action.toUpperCase().padEnd(9)} ${d.reason} [${d.basis}] 证据: ${ev || "（无遥测证据）"}` +
        (d.command ? ` → 指令 ${d.command.commandId}@${fmtLocal(d.command.issuedAt).slice(11)}${d.command.acknowledgement ? `，设备已${d.command.acknowledgement.status === "acknowledged" ? "确认" : "失败"}(${d.command.acknowledgement.eventId})` : ""}` : "（无实时指令）") +
        (d.safetyEventId ? `  → 安全事件 ${d.safetyEventId}/${d.safetyEventStatus}` : ""),
    );
    lines.push(`      ${d.detail}`);
  }
  lines.push("安全事件：");
  for (const e of s.safetyEvents) {
    lines.push(
      `  · ${e.safetyEventId} ${e.reason} [${e.severity}] ${e.status}` +
        (e.closedAt ? `（由 ${e.closedByReviewId} 于 ${fmtLocal(e.closedAt)} 关闭）` : "（待复核）") +
        ` 证据事件: ${e.evidenceEventIds.join(",")}`,
    );
  }
  lines.push("徽章裁决：");
  for (const { claim, eligibility } of s.badgeClaims) {
    lines.push(`  · ${claim.claimId} ${claim.badgeCode} → ${eligibility.status.toUpperCase()}（${eligibility.reasons.join("；") || "符合条件"}）`);
  }
  if (s.archive) {
    lines.push(`封存：${s.archive.policyId} 至 ${s.archive.retentionUntil.slice(0, 10)}，指纹 ${s.archive.storageFingerprint.slice(0, 16)}…`);
  }
  return lines.join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
