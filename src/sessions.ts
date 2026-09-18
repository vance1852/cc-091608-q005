import type {
  ArchiveRecord,
  CommandAcknowledgment,
  CompletionBadge,
  DeletionAttempt,
  DeviceBadgeNotice,
  DeviceCommand,
  HelpRequest,
  PrescriptionVersion,
  SafetyDecision,
  SafetyIncident,
  SessionEndKind,
  SessionState,
  SessionSummary,
  TelemetryEvent,
  TherapistReview,
} from "./contracts.ts";
import type { PrescriptionRegistry } from "./prescriptions.ts";
import { DEFAULT_POLICY, SessionSafetyEvaluator } from "./safety.ts";
import type { SafetyPolicy } from "./safety.ts";

/**
 * 课程记录：遥测、决定、指令、设备确认、求助、复核、徽章与封存
 * 全部进入同一条记录，任何环节不另立账本。
 */
export interface SessionRecord {
  sessionId: string;
  patientId: string;
  /** 开课时固定引用的版本，后续发布/撤回都不改写 */
  prescriptionRef: { prescriptionId: string; version: number };
  prescriptionSnapshot: PrescriptionVersion;
  state: SessionState;
  startedAt: string;
  endedAt?: string;
  endedAs?: SessionEndKind;
  telemetry: TelemetryEvent[];
  lateEventIds: string[];
  decisions: SafetyDecision[];
  commands: DeviceCommand[];
  acknowledgments: CommandAcknowledgment[];
  helpRequests: HelpRequest[];
  reviews: TherapistReview[];
  incidents: SafetyIncident[];
  deviceBadges: DeviceBadgeNotice[];
  deletionAttempts: DeletionAttempt[];
  archives: ArchiveRecord[];
  badge?: CompletionBadge;
}

export class SessionService {
  private readonly records = new Map<string, SessionRecord>();
  private readonly evaluators = new Map<string, SessionSafetyEvaluator>();
  private readonly idSeq = new Map<string, number>();
  private readonly registry: PrescriptionRegistry;
  private readonly policy: SafetyPolicy;

  constructor(registry: PrescriptionRegistry, policy: SafetyPolicy = DEFAULT_POLICY) {
    this.registry = registry;
    this.policy = policy;
  }

  /** 开课：必须存在已签署且在有效期内的版本，并固定引用该版本。 */
  startSession(patientId: string, prescriptionId: string, sessionId: string, startedAt: string): SessionSummary {
    if (this.records.has(sessionId)) {
      throw new Error(`课程已存在：${sessionId}`);
    }
    const active = this.registry.activeVersionAt(prescriptionId, startedAt);
    if (active === undefined) {
      throw new Error(`开始时间 ${startedAt} 没有已签署且有效的处方 ${prescriptionId}（未签署、已撤回或不在有效期均不能开课）`);
    }
    if (active.draft.patientId !== patientId) {
      throw new Error(`处方 ${prescriptionId} 不属于患者 ${patientId}`);
    }
    const snapshot = this.registry.issuedVersion(prescriptionId, active.draft.version);
    const record: SessionRecord = {
      sessionId,
      patientId,
      prescriptionRef: { prescriptionId, version: active.draft.version },
      prescriptionSnapshot: snapshot,
      state: "active",
      startedAt,
      telemetry: [],
      lateEventIds: [],
      decisions: [],
      commands: [],
      acknowledgments: [],
      helpRequests: [],
      reviews: [],
      incidents: [],
      deviceBadges: [],
      deletionAttempts: [],
      archives: [],
    };
    this.records.set(sessionId, record);
    this.evaluators.set(sessionId, new SessionSafetyEvaluator(snapshot, this.policy));
    return this.buildSummary(sessionId);
  }

  /**
   * 摄入遥测。原始事件先入库；评估按事件时间进行；
   * 迟到数据只补充复核证据，绝不倒推发送实时指令。
   */
  ingestTelemetry(event: TelemetryEvent): void {
    const record = this.mustGet(event.sessionId);
    const evaluator = this.mustEvaluator(event.sessionId);
    record.telemetry.push(event);

    const outcome = evaluator.ingest(event);

    if (outcome.kind === "late") {
      record.lateEventIds.push(event.eventId);
      const open = record.incidents.find((i) => i.status === "open");
      if (open !== undefined) {
        if (outcome.violatedLimits && !open.evidenceEventIds.includes(event.eventId)) {
          open.evidenceEventIds.push(event.eventId);
        }
      } else if (outcome.violatedLimits) {
        // 没有未关闭的安全事件，但迟到数据揭示当时已超限：
        // 登记一条复核级决定（不向设备发任何指令），开启安全事件等待复核。
        const decision = this.recordDecision(
          record,
          "seek-help",
          "late-evidence-violation",
          `迟到数据（采集于 ${event.capturedAt}）显示当时已超出临床限制，仅登记复核，不倒推实时指令`,
          [event.eventId],
          event.receivedAt,
        );
        this.attachToIncident(record, decision, event.receivedAt);
      }
      this.recomputeState(record);
      return;
    }

    if (outcome.kind === "decision") {
      const d = outcome.decision;
      // 决策时间一律取数据到达时间，绝不按采集时间倒推
      const decidedAt = event.receivedAt;
      const decision = this.recordDecision(record, d.action, d.rule, d.reason, d.evidenceEventIds, decidedAt);
      if (d.action === "pause") {
        this.issueCommand(record, "pause", decision, d.reason, decidedAt);
      } else if (d.action === "stop" || d.action === "seek-help") {
        this.issueCommand(record, "stop", decision, d.reason, decidedAt);
        record.endedAs = "stopped";
        record.endedAt = decidedAt;
      }
      this.attachToIncident(record, decision, decidedAt);
      this.recomputeState(record);
    }
  }

  /** 设备确认暂停/停止，进入同一课程记录。 */
  acknowledgeCommand(sessionId: string, commandId: string, deviceId: string, acknowledgedAt: string): void {
    const record = this.mustGet(sessionId);
    if (!record.commands.some((c) => c.commandId === commandId)) {
      throw new Error(`课程 ${sessionId} 不存在指令 ${commandId}`);
    }
    if (record.acknowledgments.some((a) => a.commandId === commandId)) {
      throw new Error(`指令 ${commandId} 已被确认过`);
    }
    record.acknowledgments.push({ commandId, sessionId, deviceId, acknowledgedAt });
  }

  /** 患者请求帮助：记录并升级为 seek-help 决定，汇入当前安全事件。 */
  requestHelp(sessionId: string, requestedAt: string, note?: string): HelpRequest {
    const record = this.mustGet(sessionId);
    const request: HelpRequest = {
      requestId: this.nextId("help"),
      sessionId,
      requestedAt,
      ...(note !== undefined ? { note } : {}),
    };
    record.helpRequests.push(request);
    const decision = this.recordDecision(
      record,
      "seek-help",
      "patient-help-request",
      `患者主动请求帮助（${request.requestId}）`,
      [],
      requestedAt,
    );
    this.attachToIncident(record, decision, requestedAt);
    this.recomputeState(record);
    return request;
  }

  /** 治疗师复核：只有复核能关闭安全事件。 */
  review(
    sessionId: string,
    safetyEventId: string,
    reviewedBy: string,
    outcome: "closed" | "escalated",
    reviewedAt: string,
    note?: string,
  ): TherapistReview {
    const record = this.mustGet(sessionId);
    const incident = record.incidents.find((i) => i.safetyEventId === safetyEventId);
    if (incident === undefined) {
      throw new Error(`课程 ${sessionId} 不存在安全事件 ${safetyEventId}`);
    }
    if (incident.status !== "open") {
      throw new Error(`安全事件 ${safetyEventId} 已关闭，不能重复复核`);
    }
    const review: TherapistReview = {
      reviewId: this.nextId("rev"),
      sessionId,
      safetyEventId,
      reviewedBy,
      reviewedAt,
      outcome,
      ...(note !== undefined ? { note } : {}),
    };
    record.reviews.push(review);
    if (outcome === "closed") {
      incident.status = "closed";
      incident.closedByReviewId = review.reviewId;
      incident.closedAt = reviewedAt;
    }
    this.recomputeState(record);
    return review;
  }

  /** 达到处方时长后结束课程；有未关闭安全事件时进入 under-review。 */
  finishSession(sessionId: string, finishedAt: string): void {
    const record = this.mustGet(sessionId);
    if (record.endedAs !== undefined) {
      throw new Error(`课程 ${sessionId} 已结束`);
    }
    const elapsedMinutes = (Date.parse(finishedAt) - Date.parse(record.startedAt)) / 60_000;
    if (elapsedMinutes < record.prescriptionSnapshot.durationMinutes) {
      throw new Error(`训练时长不足处方 ${record.prescriptionSnapshot.durationMinutes} 分钟，不能标记完成`);
    }
    record.endedAs = "duration-met";
    record.endedAt = finishedAt;
    this.mustEvaluator(sessionId).close();
    this.recomputeState(record);
  }

  /**
   * 完成徽章：课程按处方完成且所有安全事件关闭后才能生成。
   * 设备侧达标徽章（deviceBadges）不参与判定，不能凌驾临床安全限制。
   */
  tryAwardBadge(sessionId: string, awardedAt: string): CompletionBadge {
    const record = this.mustGet(sessionId);
    if (record.badge !== undefined) return record.badge;
    const open = record.incidents.filter((i) => i.status === "open");
    if (open.length > 0) {
      throw new Error(`存在未关闭安全事件（${open.map((i) => i.safetyEventId).join(", ")}），不能生成完成徽章`);
    }
    if (record.state !== "completed") {
      throw new Error(`课程状态为 ${record.state}，未按处方完成，不能生成完成徽章`);
    }
    const badge: CompletionBadge = {
      badgeId: this.nextId("badge"),
      sessionId,
      awardedAt,
      durationMinutes: record.prescriptionSnapshot.durationMinutes,
    };
    record.badge = badge;
    return badge;
  }

  /** 设备上报的达标徽章仅作记录，对安全状态与徽章门控没有任何影响。 */
  recordDeviceBadge(sessionId: string, label: string, reportedAt: string): void {
    const record = this.mustGet(sessionId);
    record.deviceBadges.push({ sessionId, label, reportedAt });
  }

  /** 原始遥测属于临床记录：不能删除（患者本人也不行），只能按保留策略封存。 */
  requestTelemetryDeletion(
    sessionId: string,
    eventIds: string[],
    requestedBy: string,
    requestedAt: string,
  ): { accepted: false; reason: string } {
    const record = this.mustGet(sessionId);
    const reason = "原始遥测属于临床记录，只能按保留策略封存，不能删除（患者本人也不例外）";
    record.deletionAttempts.push({
      sessionId,
      requestedBy,
      eventIds: [...eventIds],
      requestedAt,
      outcome: "rejected",
      reason,
    });
    return { accepted: false, reason };
  }

  /** 按保留策略封存原始遥测（封存不是删除，记录仍可追溯）。 */
  archiveTelemetry(sessionId: string, retentionDays: number, archivedAt: string): ArchiveRecord {
    const record = this.mustGet(sessionId);
    if (!(retentionDays > 0)) {
      throw new Error("保留天数必须为正数");
    }
    const archive: ArchiveRecord = {
      archiveId: this.nextId("arch"),
      sessionId,
      sealedAt: archivedAt,
      retentionUntil: new Date(Date.parse(archivedAt) + retentionDays * 86_400_000).toISOString(),
      eventCount: record.telemetry.length,
    };
    record.archives.push(archive);
    return archive;
  }

  /** 撤回处方：进行中的课程收到停止原因；已结束的课程保持原样。 */
  stopSessionsForWithdrawal(prescriptionId: string, version: number, reason: string, at: string): string[] {
    const affected: string[] = [];
    for (const record of this.records.values()) {
      if (record.prescriptionRef.prescriptionId !== prescriptionId || record.prescriptionRef.version !== version) {
        continue;
      }
      if (record.endedAs !== undefined) continue;
      const decision = this.recordDecision(
        record,
        "stop",
        "prescription-withdrawn",
        `处方 ${prescriptionId} v${version} 已撤回：${reason}`,
        [],
        at,
      );
      this.issueCommand(record, "stop", decision, `处方撤回：${reason}`, at);
      record.endedAs = "stopped";
      record.endedAt = at;
      this.mustEvaluator(record.sessionId).close();
      this.attachToIncident(record, decision, at);
      this.recomputeState(record);
      affected.push(record.sessionId);
    }
    return affected;
  }

  telemetryOf(sessionId: string): TelemetryEvent[] {
    return structuredClone(this.mustGet(sessionId).telemetry);
  }

  /** 课程摘要：每条安全决定都能追到规则、证据事件与指令。 */
  buildSummary(sessionId: string): SessionSummary {
    const record = this.mustGet(sessionId);
    return {
      sessionId: record.sessionId,
      patientId: record.patientId,
      prescriptionRef: { ...record.prescriptionRef },
      state: record.state,
      startedAt: record.startedAt,
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      ...(record.endedAs !== undefined ? { endedAs: record.endedAs } : {}),
      telemetryCount: record.telemetry.length,
      lateEventIds: [...record.lateEventIds],
      decisions: record.decisions.map((d) => {
        const command = record.commands.find((c) => c.decisionId === d.decisionId);
        return {
          decisionId: d.decisionId,
          rule: d.rule,
          action: d.action,
          reason: d.reason,
          decidedAt: d.decidedAt,
          evidenceEventIds: [...d.evidenceEventIds],
          ...(command !== undefined ? { commandId: command.commandId } : {}),
        };
      }),
      safetyEvents: record.incidents.map((i) => ({
        safetyEventId: i.safetyEventId,
        status: i.status,
        openedByDecisionId: i.openedByDecisionId,
        openedAt: i.openedAt,
        evidenceEventIds: [...i.evidenceEventIds],
        decisionIds: [...i.decisionIds],
        ...(i.closedByReviewId !== undefined ? { closedByReviewId: i.closedByReviewId } : {}),
        ...(i.closedAt !== undefined ? { closedAt: i.closedAt } : {}),
      })),
      commands: record.commands.map((c) => ({ ...c })),
      acknowledgments: record.acknowledgments.map((a) => ({ ...a })),
      helpRequests: record.helpRequests.map((h) => ({ ...h })),
      reviews: record.reviews.map((r) => ({ ...r })),
      deviceBadges: record.deviceBadges.map((b) => ({ ...b })),
      deletionAttempts: record.deletionAttempts.map((d) => ({ ...d, eventIds: [...d.eventIds] })),
      archives: record.archives.map((a) => ({ ...a })),
      ...(record.badge !== undefined ? { badge: { ...record.badge } } : {}),
    };
  }

  private recordDecision(
    record: SessionRecord,
    action: SafetyDecision["action"],
    rule: string,
    reason: string,
    evidenceEventIds: string[],
    decidedAt: string,
  ): SafetyDecision {
    const decision: SafetyDecision = {
      decisionId: this.nextId("dec"),
      sessionId: record.sessionId,
      action,
      evidenceEventIds: [...evidenceEventIds],
      decidedAt,
      rule,
      reason,
    };
    record.decisions.push(decision);
    return decision;
  }

  private issueCommand(
    record: SessionRecord,
    kind: DeviceCommand["kind"],
    decision: SafetyDecision,
    reason: string,
    issuedAt: string,
  ): DeviceCommand {
    const command: DeviceCommand = {
      commandId: this.nextId("cmd"),
      sessionId: record.sessionId,
      kind,
      reason,
      issuedAt,
      decisionId: decision.decisionId,
    };
    record.commands.push(command);
    return command;
  }

  private attachToIncident(record: SessionRecord, decision: SafetyDecision, at: string): void {
    if (decision.action === "continue") return;
    let incident = record.incidents.find((i) => i.status === "open");
    if (incident === undefined) {
      incident = {
        safetyEventId: this.nextId("inc"),
        sessionId: record.sessionId,
        status: "open",
        openedByDecisionId: decision.decisionId,
        openedAt: at,
        evidenceEventIds: [],
        decisionIds: [],
      };
      record.incidents.push(incident);
    }
    incident.decisionIds.push(decision.decisionId);
    for (const id of decision.evidenceEventIds) {
      if (!incident.evidenceEventIds.includes(id)) incident.evidenceEventIds.push(id);
    }
  }

  private recomputeState(record: SessionRecord): void {
    if (record.endedAs === undefined) {
      record.state = this.mustEvaluator(record.sessionId).currentPhase === "paused" ? "paused" : "active";
      return;
    }
    const hasOpenIncident = record.incidents.some((i) => i.status === "open");
    record.state = hasOpenIncident ? "under-review" : record.endedAs === "duration-met" ? "completed" : "stopped";
  }

  private nextId(prefix: string): string {
    const n = (this.idSeq.get(prefix) ?? 0) + 1;
    this.idSeq.set(prefix, n);
    return `${prefix}-${n}`;
  }

  private mustGet(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined) throw new Error(`未知课程：${sessionId}`);
    return record;
  }

  private mustEvaluator(sessionId: string): SessionSafetyEvaluator {
    const evaluator = this.evaluators.get(sessionId);
    if (evaluator === undefined) throw new Error(`未知课程：${sessionId}`);
    return evaluator;
  }
}
