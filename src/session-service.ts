/**
 * 康复训练安全服务（核心）。
 *
 * 不变量：
 * 1. 开课固定处方版本：绑定冻结快照与指纹，之后发布新版本或撤回都不改写课程记录。
 * 2. 实时指令只基于 watermark（服务器处理时刻）前已收到的证据，issuedAt 取服务器时钟；
 *    迟到数据到达时若课程已终止，只形成 review-only 决定，绝不倒推指令。
 * 3. 遥测、症状、指令、设备确认、求助、复核、徽章声称、封存全部进入同一 append-only 课程记录。
 * 4. 安全事件未关闭 → 完成徽章一律拒绝；设备徽章声称只留痕，不参与裁决。
 * 5. 原始遥测只能按保留策略封存（seal），不存在患者删除入口。
 */
import type {
  BadgeEligibility,
  ClinicianReview,
  DeviceAcknowledgement,
  DeviceBadgeClaim,
  DeviceCommand,
  HelpRequest,
  HeartRateZone,
  PrescriptionBinding,
  PrescriptionVersion,
  RecallNotice,
  SafetyAction,
  SafetyDecision,
  SafetyEvent,
  SafetyReasonCode,
  SessionState,
  TelemetryEvent,
} from "./contracts.js";
import { canonicalJSON, sha256Hex } from "./crypto.js";
import { SessionLog, type ArchiveManifest } from "./session-log.js";
import { PrescriptionRegistry } from "./prescription.js";
import {
  evaluateAtWatermark,
  evaluateAvailable,
  type RuleFinding,
  type SafetyRuleConfig,
  DEFAULT_RULES,
} from "./safety-engine.js";

/** 确定性 ID 生成器（回放/测试用）；生产可替换为随机实现。 */
export interface IdFactory {
  next(prefix: string): string;
}

export class CounterIds implements IdFactory {
  private readonly counts = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.counts.get(prefix) ?? 0) + 1;
    this.counts.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

export interface StartSessionParams {
  sessionId: string;
  prescriptionId: string;
  version: number;
  startAt: Date;
  /** 腕表本地缓存的区间（可能是上周的）；仅留痕比对，绝不采用 */
  deviceReportedZone?: HeartRateZone;
}

const ACTIONABLE_STATES: ReadonlySet<SessionState> = new Set<SessionState>(["active", "paused"]);
const TERMINAL_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "stopped",
  "under-review",
  "completed",
]);

export class RehabSession {
  state: SessionState = "active";
  readonly events: TelemetryEvent[] = [];
  readonly decisions: SafetyDecision[] = [];
  readonly commands: DeviceCommand[] = [];
  readonly acknowledgements: DeviceAcknowledgement[] = [];
  readonly helpRequests: HelpRequest[] = [];
  readonly reviews: ClinicianReview[] = [];
  readonly badgeClaims: Array<{ claim: DeviceBadgeClaim; eligibility: BadgeEligibility }> = [];
  archive: ArchiveManifest | null = null;

  private readonly safetyEventsMap = new Map<string, SafetyEvent>();
  private readonly actionedKeys = new Set<string>();
  /** 有效训练时间区间（服务器状态为准；停止后患者擅自继续不计入） */
  private readonly activeIntervals: Array<{ from: Date; to?: Date }> = [];

  constructor(
    readonly log: SessionLog,
    readonly binding: PrescriptionBinding,
    readonly prescriptionSnapshot: PrescriptionVersion,
    startAt: Date,
  ) {
    this.activeIntervals.push({ from: startAt });
  }

  get sessionId(): string {
    return this.log.sessionId;
  }

  get safetyEvents(): SafetyEvent[] {
    return [...this.safetyEventsMap.values()];
  }

  get openSafetyEvents(): SafetyEvent[] {
    return this.safetyEvents.filter((e) => e.status === "open");
  }

  get isActionable(): boolean {
    return ACTIONABLE_STATES.has(this.state);
  }

  activeTrainingMinutes(now: Date): number {
    let msTotal = 0;
    for (const interval of this.activeIntervals) {
      const end = interval.to ?? now;
      msTotal += Math.max(0, end.getTime() - interval.from.getTime());
    }
    return Math.round((msTotal / 60000) * 10) / 10;
  }

  /** 状态进入暂停/停止时闭合当前有效训练区间。 */
  closeActiveInterval(at: Date): void {
    const last = this.activeIntervals[this.activeIntervals.length - 1];
    if (last && !last.to) last.to = at;
  }

  /** 服务器认可的恢复：重新开始累计有效训练时长。 */
  reopenActiveInterval(at: Date): void {
    const last = this.activeIntervals[this.activeIntervals.length - 1];
    if (last && !last.to) return;
    this.activeIntervals.push({ from: at });
  }

  findingKey(finding: RuleFinding): string {
    return `${finding.reason}:${[...finding.evidenceEventIds].sort().join(",")}`;
  }

  alreadyActioned(finding: RuleFinding): boolean {
    return this.actionedKeys.has(this.findingKey(finding));
  }

  markActioned(finding: RuleFinding): void {
    this.actionedKeys.add(this.findingKey(finding));
  }

  /** 为决定建立（或合并到同类未关闭的）安全事件。 */
  openOrMergeSafetyEvent(
    id: string,
    now: Date,
    reason: SafetyReasonCode,
    severity: "critical" | "caution",
    decision: SafetyDecision,
    basis: "real-time" | "review-only",
  ): SafetyEvent {
    const existing = this.safetyEvents.find((e) => e.reason === reason && e.status === "open");
    if (existing) {
      const updated: SafetyEvent = {
        ...existing,
        severity: existing.severity === "critical" ? "critical" : severity,
        triggerDecisionIds: [...existing.triggerDecisionIds, decision.decisionId],
        evidenceEventIds: [...new Set([...existing.evidenceEventIds, ...decision.evidenceEventIds])],
      };
      this.safetyEventsMap.set(existing.safetyEventId, updated);
      this.log.append("safety-event", now, updated);
      decision.safetyEventId = existing.safetyEventId;
      return updated;
    }

    const opened: SafetyEvent = {
      safetyEventId: id,
      sessionId: this.sessionId,
      reason,
      severity,
      openedAt: now.toISOString(),
      triggerDecisionIds: [decision.decisionId],
      evidenceEventIds: [...decision.evidenceEventIds],
      status: "open",
      ...(basis === "review-only"
        ? { clinicianNotes: "由迟到/终止后证据在复核阶段建立，未下发实时指令" }
        : {}),
    };
    this.safetyEventsMap.set(id, opened);
    this.log.append("safety-event", now, opened);
    decision.safetyEventId = id;
    return opened;
  }

  addTriggerDecision(safetyEventId: string, decisionId: string, now: Date): void {
    const evt = this.safetyEventsMap.get(safetyEventId);
    if (!evt) return;
    const updated: SafetyEvent = {
      ...evt,
      triggerDecisionIds: [...evt.triggerDecisionIds, decisionId],
    };
    this.safetyEventsMap.set(safetyEventId, updated);
    this.log.append("safety-event", now, updated);
  }

  closeSafetyEvent(safetyEventId: string, review: ClinicianReview, now: Date): SafetyEvent {
    const evt = this.safetyEventsMap.get(safetyEventId);
    if (!evt) throw new Error(`安全事件 ${safetyEventId} 不属于课程 ${review.sessionId}`);
    const closed: SafetyEvent = {
      ...evt,
      status: "closed",
      closedByReviewId: review.reviewId,
      closedAt: review.at,
      clinicianNotes: review.notes,
    };
    this.safetyEventsMap.set(safetyEventId, closed);
    this.log.append("safety-event", now, closed);
    return closed;
  }
}

export interface IngestResult {
  decisions: SafetyDecision[];
  command: DeviceCommand | null;
}

export class SessionService {
  private readonly sessions = new Map<string, RehabSession>();

  constructor(
    private readonly registry: PrescriptionRegistry,
    private readonly ids: IdFactory = new CounterIds(),
    private readonly rules: SafetyRuleConfig = DEFAULT_RULES,
  ) {}

  getSession(sessionId: string): RehabSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`未知课程：${sessionId}`);
    return session;
  }

  /** 患者开始训练：验方（撤回/有效期）、固定版本、写入绑定。 */
  startSession(params: StartSessionParams): RehabSession {
    const { sessionId, prescriptionId, version, startAt } = params;
    if (this.sessions.has(sessionId)) throw new Error(`课程 ${sessionId} 已存在`);

    // 撤回只阻止新课程：assertUsable 在撤回/失效时直接拒绝。
    const signed = this.registry.assertUsable(prescriptionId, version, startAt);
    const fingerprint = this.registry.fingerprint(prescriptionId, version);

    const zone = signed.prescription.heartRateZone;
    const deviceZone = params.deviceReportedZone;
    const zoneMismatch =
      deviceZone !== undefined &&
      (deviceZone.minimum !== zone.minimum || deviceZone.maximum !== zone.maximum);

    const binding: PrescriptionBinding = {
      sessionId,
      prescriptionId,
      version,
      signature: signed.signature,
      keyId: signed.keyId,
      fingerprint,
      boundAt: startAt.toISOString(),
      ...(deviceZone ? { deviceReportedZone: deviceZone } : {}),
      zoneMismatch,
    };

    const log = new SessionLog(sessionId);
    log.append("binding", startAt, binding);
    const session = new RehabSession(log, binding, signed.prescription, startAt);
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * 接收一条遥测/症状事件并在 watermark=now 评估。
   * 调用方必须按 receivedAt 单调推进时钟；服务器时钟只进不退。
   */
  ingest(event: TelemetryEvent, now: Date): IngestResult {
    const session = this.getSession(event.sessionId);
    if (new Date(event.receivedAt).getTime() > now.getTime()) {
      throw new Error(`事件 ${event.eventId} 的 receivedAt 晚于服务器处理时间，拒绝倒推`);
    }
    if (session.events.some((e) => e.eventId === event.eventId)) {
      throw new Error(`事件 ${event.eventId} 已入库，遥测记录不可重复写入`);
    }
    session.log.append("telemetry", now, event);
    session.events.push(event);

    // 评估前的课程状态决定本批证据能否产生实时指令：
    // 课程已终止后才首次成立的命中，一律只进入复核。
    const wasActionable = session.isActionable;
    const basis = wasActionable ? "real-time" : "review-only";
    const { findings } = evaluateAtWatermark(
      session.prescriptionSnapshot,
      session.events,
      now,
      this.rules,
    );

    const decisions: SafetyDecision[] = [];
    let command: DeviceCommand | null = null;

    if (findings.length === 0) {
      if (session.state === "active") decisions.push(this.recordWithinLimits(session, event, now));
      return { decisions, command };
    }

    for (const finding of findings) {
      if (session.alreadyActioned(finding)) continue;
      session.markActioned(finding);
      const result = this.issueForFinding(session, finding, now, basis);
      decisions.push(result.decision);
      if (result.command && !command) command = result.command;
      if (result.extra) decisions.push(result.extra);
    }
    return { decisions, command };
  }

  private recordWithinLimits(
    session: RehabSession,
    event: TelemetryEvent,
    now: Date,
  ): SafetyDecision {
    const decision: SafetyDecision = {
      decisionId: this.ids.next("d"),
      sessionId: session.sessionId,
      action: "continue",
      reason: "within-limits",
      basis: "real-time",
      evidenceEventIds: [event.eventId],
      evidenceCapturedFrom: event.capturedAt,
      evidenceCapturedTo: event.capturedAt,
      decidedAt: now.toISOString(),
      detail:
        event.heartRate !== undefined
          ? `心率 ${event.heartRate} bpm 在签署区间内，继续训练`
          : "未发现超限或症状",
    };
    session.decisions.push(decision);
    session.log.append("decision", now, decision);
    return decision;
  }

  private issueForFinding(
    session: RehabSession,
    finding: RuleFinding,
    now: Date,
    basis: "real-time" | "review-only",
  ): { decision: SafetyDecision; command: DeviceCommand | null; extra?: SafetyDecision } {
    const action: SafetyAction = finding.severity === "critical" ? "stop" : "pause";
    const decision: SafetyDecision = {
      decisionId: this.ids.next("d"),
      sessionId: session.sessionId,
      action,
      reason: finding.reason,
      basis,
      evidenceEventIds: finding.evidenceEventIds,
      evidenceCapturedFrom: finding.capturedFrom,
      evidenceCapturedTo: finding.capturedTo,
      decidedAt: now.toISOString(),
      detail:
        basis === "review-only"
          ? `${finding.detail}（证据迟到/课程已终止：仅补充复核，未倒推下发任何实时指令）`
          : finding.detail,
    };

    // 安全事件先建档，再挂决定，保证摘要可双向追溯。
    session.openOrMergeSafetyEvent(
      this.ids.next("se"),
      now,
      finding.reason,
      finding.severity === "critical" ? "critical" : "caution",
      decision,
      basis,
    );

    let command: DeviceCommand | null = null;
    if (basis === "real-time" && session.isActionable) {
      // 已暂停时只接受升级为停止，不重复发暂停指令。
      const needsCommand = action === "stop" || (action === "pause" && session.state === "active");
      if (needsCommand) {
        command = {
          commandId: this.ids.next("cmd"),
          sessionId: session.sessionId,
          action,
          reason: finding.reason,
          issuedAt: now.toISOString(),
          basedOnDecisionId: decision.decisionId,
        };
        session.commands.push(command);
        session.log.append("command", now, command);
        decision.commandId = command.commandId;
      }

      session.closeActiveInterval(now);
      session.state = action === "stop" ? "stopped" : "paused";
    }

    session.decisions.push(decision);
    session.log.append("decision", now, decision);

    const out: { decision: SafetyDecision; command: DeviceCommand | null; extra?: SafetyDecision } = {
      decision,
      command,
    };

    // 禁忌症状：停止之外再留一条求助建议（建议性，不产生第二条设备指令）。
    if (finding.reason === "contraindicated-symptom" && basis === "real-time") {
      const seekHelp: SafetyDecision = {
        decisionId: this.ids.next("d"),
        sessionId: session.sessionId,
        action: "seek-help",
        reason: "contraindicated-symptom",
        basis,
        evidenceEventIds: finding.evidenceEventIds,
        evidenceCapturedFrom: finding.capturedFrom,
        evidenceCapturedTo: finding.capturedTo,
        decidedAt: now.toISOString(),
        ...(decision.safetyEventId ? { safetyEventId: decision.safetyEventId } : {}),
        detail: "红旗症状：保持停止，等待急救/医疗帮助，不得自行恢复训练",
      };
      session.decisions.push(seekHelp);
      session.log.append("decision", now, seekHelp);
      if (decision.safetyEventId) {
        session.addTriggerDecision(decision.safetyEventId, seekHelp.decisionId, now);
      }
      out.extra = seekHelp;
    }

    return out;
  }

  /**
   * 对已终止课程做一次全量复核调和（可选，ingest 已覆盖）：
   * 用全量事件按 capturedAt 重评，新命中只走 review-only。
   */
  reconcile(sessionId: string, now: Date): SafetyDecision[] {
    const session = this.getSession(sessionId);
    if (session.isActionable) return [];
    const findings = evaluateAvailable(session.prescriptionSnapshot, session.events, this.rules);
    const out: SafetyDecision[] = [];
    for (const finding of findings) {
      if (session.alreadyActioned(finding)) continue;
      session.markActioned(finding);
      out.push(this.issueForFinding(session, finding, now, "review-only").decision);
    }
    return out;
  }

  /**
   * 服务器认可的恢复训练（暂停后）。
   * 患者胸闷后“自行暂停几分钟又继续”不经过这里：没有 resume 记录的继续不计入有效时长，
   * 且存在未关闭危急安全事件时恢复一律拒绝——红旗症状必须先经治疗师复核。
   */
  resumeTraining(
    sessionId: string,
    by: "clinician" | "patient-confirmed",
    reason: string,
    now: Date,
  ): void {
    const session = this.getSession(sessionId);
    if (session.state !== "paused") {
      throw new Error(`课程 ${sessionId} 状态为 ${session.state}，不能恢复训练`);
    }
    const blocking = session.openSafetyEvents.filter((e) => e.severity === "critical");
    if (blocking.length > 0) {
      throw new Error(
        `课程 ${sessionId} 存在未关闭危急安全事件 ${blocking.map((e) => e.safetyEventId).join(",")}，须治疗师复核后方可恢复`,
      );
    }
    session.state = "active";
    session.reopenActiveInterval(now);
    session.log.append("resume", now, { sessionId, at: now.toISOString(), by, reason });
  }

  /** 设备确认暂停/停止：必须回到同一课程记录。 */
  acknowledge(ack: DeviceAcknowledgement, now: Date): void {
    const session = this.getSession(ack.sessionId);
    if (!session.commands.some((c) => c.commandId === ack.commandId)) {
      throw new Error(`课程 ${ack.sessionId} 不存在指令 ${ack.commandId}`);
    }
    if (session.acknowledgements.some((a) => a.eventId === ack.eventId)) {
      throw new Error(`设备确认 ${ack.eventId} 已记录`);
    }
    session.acknowledgements.push(ack);
    session.log.append("device-ack", now, ack);
  }

  /** 患者按下求助。 */
  requestHelp(request: HelpRequest, now: Date): SafetyDecision {
    const session = this.getSession(request.sessionId);
    session.helpRequests.push(request);
    session.log.append("help-request", now, request);

    const decision: SafetyDecision = {
      decisionId: this.ids.next("d"),
      sessionId: session.sessionId,
      action: "seek-help",
      reason: "patient-requested-help",
      basis: "real-time",
      evidenceEventIds: [request.eventId],
      evidenceCapturedFrom: request.at,
      evidenceCapturedTo: request.at,
      decidedAt: now.toISOString(),
      detail: request.message ? `患者求助：${request.message}` : "患者主动请求帮助",
    };
    session.openOrMergeSafetyEvent(
      this.ids.next("se"),
      now,
      "patient-requested-help",
      "critical",
      decision,
      "real-time",
    );
    session.decisions.push(decision);
    session.log.append("decision", now, decision);
    return decision;
  }

  /**
   * 撤回处方：只阻止新课程，并对此刻仍在进行（active/paused）的绑定课程
   * 发出停止指令并记录停止原因。已终止课程不受影响、历史记录不改写。
   */
  recallPrescription(prescriptionId: string, reason: string, now: Date): RecallNotice {
    this.registry.recall(prescriptionId, reason, now);
    const affected = [...this.sessions.values()].filter(
      (s) => s.binding.prescriptionId === prescriptionId && s.isActionable,
    );

    const notice: RecallNotice = {
      prescriptionId,
      reason,
      recalledAt: now.toISOString(),
      affectedActiveSessionIds: affected.map((s) => s.sessionId),
    };

    for (const session of affected) {
      const decision: SafetyDecision = {
        decisionId: this.ids.next("d"),
        sessionId: session.sessionId,
        action: "stop",
        reason: "prescription-recalled",
        basis: "real-time",
        evidenceEventIds: [],
        decidedAt: now.toISOString(),
        detail: `所引用处方已撤回：${reason}`,
      };
      session.openOrMergeSafetyEvent(
        this.ids.next("se"),
        now,
        "prescription-recalled",
        "critical",
        decision,
        "real-time",
      );
      const command: DeviceCommand = {
        commandId: this.ids.next("cmd"),
        sessionId: session.sessionId,
        action: "stop",
        reason: "prescription-recalled",
        issuedAt: now.toISOString(),
        basedOnDecisionId: decision.decisionId,
      };
      decision.commandId = command.commandId;
      session.commands.push(command);
      session.decisions.push(decision);
      session.closeActiveInterval(now);
      session.state = "stopped";
      session.log.append("decision", now, decision);
      session.log.append("command", now, command);
      session.log.append("recall", now, notice);
    }

    return notice;
  }

  /**
   * 正常结课：达到处方时长且没有任何未关闭安全事件才允许。
   * 有安全事件的课程只能走治疗师复核（submitReview）。
   */
  completeSession(sessionId: string, now: Date): RehabSession {
    const session = this.getSession(sessionId);
    if (!session.isActionable) {
      throw new Error(`课程 ${sessionId} 状态为 ${session.state}，不能正常结课`);
    }
    if (session.openSafetyEvents.length > 0) {
      throw new Error(
        `课程 ${sessionId} 存在 ${session.openSafetyEvents.length} 个未关闭安全事件，须治疗师复核`,
      );
    }
    const minutes = session.activeTrainingMinutes(now);
    if (minutes < session.prescriptionSnapshot.durationMinutes) {
      throw new Error(
        `课程 ${sessionId} 有效训练 ${minutes} 分钟，未达处方目标 ${session.prescriptionSnapshot.durationMinutes} 分钟`,
      );
    }
    session.closeActiveInterval(now);
    session.state = "completed";
    return session;
  }

  /** 治疗师复核：关闭安全事件的唯一途径；全部关闭且课程已终止 → completed。 */
  submitReview(review: ClinicianReview, now: Date): void {
    const session = this.getSession(review.sessionId);
    session.reviews.push(review);
    session.log.append("clinician-review", now, review);
    if (session.state === "stopped") session.state = "under-review";

    for (const safetyEventId of review.closeSafetyEventIds) {
      session.closeSafetyEvent(safetyEventId, review, now);
    }

    if (
      session.openSafetyEvents.length === 0 &&
      (session.state === "under-review" || session.state === "completed")
    ) {
      session.state = "completed";
    }
  }

  /** 设备自报达标徽章：只留痕，裁决权在服务器（临床限制优先）。 */
  registerBadgeClaim(claim: DeviceBadgeClaim, now: Date): BadgeEligibility {
    const session = this.getSession(claim.sessionId);
    session.log.append("badge-claim", now, claim);

    const target = session.prescriptionSnapshot.durationMinutes;
    const minutes = session.activeTrainingMinutes(now);
    const reasons: string[] = [];

    for (const evt of session.openSafetyEvents) {
      reasons.push(`安全事件 ${evt.safetyEventId}（${evt.reason}）关闭前不得生成完成徽章`);
    }
    if (TERMINAL_STATES.has(session.state) && session.state !== "completed") {
      reasons.push(`课程状态为 ${session.state}，未正常完成`);
    }
    if (session.state === "active" || session.state === "paused") {
      reasons.push("课程尚未结束");
    }
    if (minutes < target) {
      reasons.push(`有效训练 ${minutes} 分钟，未达处方目标 ${target} 分钟（设备徽章不构成豁免）`);
    }

    const eligibility: BadgeEligibility = {
      status: reasons.length === 0 ? "eligible" : "denied",
      sessionId: session.sessionId,
      badgeCode: claim.badgeCode,
      reasons,
      openSafetyEventIds: session.openSafetyEvents.map((e) => e.safetyEventId),
      durationTargetMinutes: target,
      activeTrainingMinutes: minutes,
    };
    session.badgeClaims.push({ claim, eligibility });
    session.log.append("badge-eligibility", now, eligibility);
    return eligibility;
  }

  /** 原始遥测封存：按保留策略密封并记录指纹，不删除任何原始数据。 */
  archiveRawTelemetry(
    sessionId: string,
    policy: { policyId: string; retentionUntil: string },
    now: Date,
  ): ArchiveManifest {
    const session = this.getSession(sessionId);
    const manifest: ArchiveManifest = {
      sessionId,
      policyId: policy.policyId,
      retentionUntil: policy.retentionUntil,
      sealedAt: now.toISOString(),
      telemetryEventIds: session.events.map((e) => e.eventId),
      storageFingerprint: sha256Hex(
        canonicalJSON(
          session.events.map((e) => ({
            eventId: e.eventId,
            capturedAt: e.capturedAt,
            heartRate: e.heartRate ?? null,
            symptom: e.symptom ?? null,
          })),
        ),
      ),
    };
    session.archive = manifest;
    session.log.append("archive-manifest", now, manifest);
    return manifest;
  }

  /** 患者侧删除请求：能力层面拒绝——原始遥测只能按保留策略封存。 */
  patientRequestsDeletion(sessionId: string): never {
    this.getSession(sessionId);
    throw new Error(`课程 ${sessionId} 的原始遥测属临床记录，只能按保留策略封存，患者无权删除`);
  }
}
