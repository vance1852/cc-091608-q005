import type { PrescriptionDraft, PrescriptionRecord, PrescriptionVersion } from "./contracts.ts";

/** 深冻结：已签署的处方内容（含嵌套对象与数组）不允许再被改写。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const keyOf = (prescriptionId: string, version: number): string => `${prescriptionId}#${version}`;

/**
 * 处方注册表，生命周期：草稿 → 签署 → （撤回）。
 * - 只有签署后的版本才能下发（开课）；
 * - 已签署版本不可改写，调整只能发布更高的新版本；
 * - 撤回只追加状态并阻止新课程，不回溯改写任何记录。
 */
export class PrescriptionRegistry {
  private readonly records = new Map<string, PrescriptionRecord>();

  submitDraft(draft: PrescriptionDraft): PrescriptionRecord {
    if (Date.parse(draft.validFrom) >= Date.parse(draft.validUntil)) {
      throw new Error("处方有效期无效：validFrom 必须早于 validUntil");
    }
    if (!(draft.heartRateZone.minimum < draft.heartRateZone.maximum)) {
      throw new Error("心率区间无效：minimum 必须小于 maximum");
    }
    if (!(draft.durationMinutes > 0)) {
      throw new Error("处方时长必须为正数");
    }
    const key = keyOf(draft.prescriptionId, draft.version);
    if (this.records.has(key)) {
      throw new Error(`处方版本 ${key} 已存在，不能重写；请发布新版本`);
    }
    for (const record of this.records.values()) {
      if (record.draft.prescriptionId === draft.prescriptionId && record.draft.version >= draft.version) {
        throw new Error(`版本号必须递增：${draft.prescriptionId} 已存在 v${record.draft.version}`);
      }
    }
    const record: PrescriptionRecord = { draft: structuredClone(draft), status: "draft" };
    this.records.set(key, record);
    return structuredClone(record);
  }

  /** 签署是下发的前提；签署后内容冻结。 */
  sign(prescriptionId: string, version: number, signedBy: string, signedAt: string): PrescriptionVersion {
    const record = this.mustGet(prescriptionId, version);
    if (record.status !== "draft") {
      throw new Error(`处方 ${keyOf(prescriptionId, version)} 已签署，不能改写；请发布新版本`);
    }
    record.status = "signed";
    record.signed = { signedBy, signedAt };
    deepFreeze(record.draft);
    deepFreeze(record.signed);
    return this.issuedVersion(prescriptionId, version);
  }

  /** 撤回只追加状态：阻止新课程，已签署内容保持原样。 */
  withdraw(prescriptionId: string, version: number, reason: string, withdrawnAt: string): void {
    const record = this.mustGet(prescriptionId, version);
    if (record.status === "draft") {
      throw new Error(`处方 ${keyOf(prescriptionId, version)} 尚未签署下发，无需撤回`);
    }
    if (record.status === "withdrawn") {
      throw new Error(`处方 ${keyOf(prescriptionId, version)} 已撤回`);
    }
    record.status = "withdrawn";
    record.withdrawal = { reason, withdrawnAt };
    deepFreeze(record.withdrawal);
  }

  /** 下发用快照：草稿一律拒绝；已撤回版本仅供历史追溯，新课程由 activeVersionAt 把关。 */
  issuedVersion(prescriptionId: string, version: number): PrescriptionVersion {
    const record = this.mustGet(prescriptionId, version);
    if (record.status === "draft" || record.signed === undefined) {
      throw new Error(`处方 ${keyOf(prescriptionId, version)} 尚未签署，不能下发`);
    }
    const signed = record.signed;
    return deepFreeze(structuredClone({ ...record.draft, signedBy: signed.signedBy }));
  }

  /** 某时刻对某处方 ID 实际有效的版本：已签署、未撤回、在有效期内，取最高版本。 */
  activeVersionAt(prescriptionId: string, at: string): PrescriptionRecord | undefined {
    const atMs = Date.parse(at);
    let best: PrescriptionRecord | undefined;
    for (const record of this.records.values()) {
      if (record.draft.prescriptionId !== prescriptionId || record.status !== "signed") continue;
      const from = Date.parse(record.draft.validFrom);
      const until = Date.parse(record.draft.validUntil);
      if (from <= atMs && atMs <= until) {
        if (best === undefined || record.draft.version > best.draft.version) best = record;
      }
    }
    return best === undefined ? undefined : structuredClone(best);
  }

  record(prescriptionId: string, version: number): PrescriptionRecord {
    return structuredClone(this.mustGet(prescriptionId, version));
  }

  private mustGet(prescriptionId: string, version: number): PrescriptionRecord {
    const record = this.records.get(keyOf(prescriptionId, version));
    if (record === undefined) {
      throw new Error(`未知处方版本：${keyOf(prescriptionId, version)}`);
    }
    return record;
  }
}
