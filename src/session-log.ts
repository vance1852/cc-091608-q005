/**
 * 同一课程记录（single session record）。
 *
 * 遥测、症状、指令、设备确认、求助、复核、徽章声称、封存记录全部进入同一条
 * append-only 哈希链。任何追加都带 prevHash；记录不可改、不可删（患者侧也没有删除入口）。
 */
import { createHash } from "node:crypto";
import type {
  ClinicianReview,
  DeviceAcknowledgement,
  DeviceBadgeClaim,
  DeviceCommand,
  HelpRequest,
  PrescriptionBinding,
  RecallNotice,
  SafetyDecision,
  SafetyEvent,
  TelemetryEvent,
} from "./contracts.js";

export type LogEntryType =
  | "telemetry"
  | "binding"
  | "decision"
  | "command"
  | "device-ack"
  | "help-request"
  | "safety-event"
  | "clinician-review"
  | "badge-claim"
  | "badge-eligibility"
  | "recall"
  | "resume"
  | "archive-manifest";

export interface LogEntryPayloads {
  telemetry: TelemetryEvent;
  binding: PrescriptionBinding;
  decision: SafetyDecision;
  command: DeviceCommand;
  "device-ack": DeviceAcknowledgement;
  "help-request": HelpRequest;
  "safety-event": SafetyEvent;
  "clinician-review": ClinicianReview;
  "badge-claim": DeviceBadgeClaim;
  "badge-eligibility": import("./contracts.js").BadgeEligibility;
  recall: RecallNotice;
  resume: ResumeRecord;
  "archive-manifest": ArchiveManifest;
}

/** 服务器认可的暂停后恢复；患者自行离线继续不在册、不计入有效时长。 */
export interface ResumeRecord {
  sessionId: string;
  at: string;
  by: "clinician" | "patient-confirmed";
  reason: string;
}

/** 原始遥测封存清单：按保留策略只允许封存，不允许删除。 */
export interface ArchiveManifest {
  sessionId: string;
  policyId: string;
  retentionUntil: string;
  sealedAt: string;
  telemetryEventIds: string[];
  /** 明文数据移出在线库后的密文/对象存储指纹；原始内容不删除 */
  storageFingerprint: string;
}

export interface LogEntry<T extends LogEntryType = LogEntryType> {
  seq: number;
  at: string;
  sessionId: string;
  type: T;
  data: LogEntryPayloads[T];
  prevHash: string;
  hash: string;
}

function digest(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

export class SessionLog {

  readonly entries: LogEntry[] = [];

  constructor(readonly sessionId: string) {}

  append<T extends LogEntryType>(type: T, at: Date, data: LogEntryPayloads[T]): LogEntry<T> {
    const sessionId = this.sessionId;
    const seq = this.entries.length + 1;
    const prevHash = this.entries.length === 0 ? "GENESIS" : (this.entries[this.entries.length - 1]?.hash as string);
    const atIso = at.toISOString();
    const hash = digest([prevHash, seq, sessionId, type, atIso, JSON.stringify(data)]);
    const entry: LogEntry<T> = { seq, at: atIso, sessionId, type, data, prevHash, hash };
    this.entries.push(entry as LogEntry);
    return entry;
  }

  /** 重算哈希链；复核/审计用，任何篡改都会在此暴露。 */
  verifyChain(): void {
    let prev = "GENESIS";
    for (const entry of this.entries) {
      const expected = digest([prev, entry.seq, entry.sessionId, entry.type, entry.at, JSON.stringify(entry.data)]);
      if (entry.prevHash !== prev || entry.hash !== expected) {
        throw new Error(`课程记录哈希链在 seq=${entry.seq} 处不一致`);
      }
      prev = entry.hash;
    }
  }

  byType<T extends LogEntryType>(type: T): Array<LogEntry<T>> {
    return this.entries.filter((e): e is LogEntry<T> => e.type === type);
  }
}
