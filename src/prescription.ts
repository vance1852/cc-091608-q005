/**
 * 处方签发与登记。
 *
 * 规则：
 * - 只有通过治疗师公钥验签的处方才能登记下发；
 * - 同一 prescriptionId 的 version 严格递增，已发布版本内容冻结（深冻结）；
 * - 撤回只做标记：阻止后续开课，并由 SessionService 通知进行中的课程；
 * - 患者开始训练时拿到的是登记版本的冻结副本，之后任何新版本都不改写它。
 */
import { type KeyObject, createPublicKey, generateKeyPairSync } from "node:crypto";
import type { PrescriptionVersion, SignedPrescription } from "./contracts.js";
import { canonicalJSON, sha256Hex, signCanonical, verifyCanonical } from "./crypto.js";

export class TherapistKeyring {
  private readonly keys = new Map<string, KeyObject>();

  /** 测试/演示用：生成一把治疗师签名密钥。 */
  static generateDemoKey(keyId: string): { keyring: TherapistKeyring; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyring = new TherapistKeyring();
    keyring.register(keyId, publicKey);
    return { keyring, privateKey };
  }

  register(keyId: string, publicKey: KeyObject | string): void {
    const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("仅接受 Ed25519 治疗师签名密钥");
    }
    this.keys.set(keyId, key);
  }

  get(keyId: string): KeyObject {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`未登记的签名密钥：${keyId}`);
    }
    return key;
  }
}

export interface StoredPrescription {
  signed: SignedPrescription;
  fingerprint: string;
  publishedAt: Date;
}

interface RecallMarker {
  reason: string;
  recalledAt: Date;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function validate(p: PrescriptionVersion): void {
  if (!p.prescriptionId || !p.patientId || !p.signedBy) {
    throw new Error("处方缺少标识字段");
  }
  if (!Number.isInteger(p.version) || p.version < 1) {
    throw new Error("处方版本必须是 >=1 的整数");
  }
  const from = new Date(p.validFrom).getTime();
  const until = new Date(p.validUntil).getTime();
  if (!(from < until)) {
    throw new Error("处方有效期非法：validFrom 必须早于 validUntil");
  }
  const { minimum, maximum } = p.heartRateZone;
  if (!(minimum >= 0 && maximum > minimum)) {
    throw new Error("处方心率区间非法");
  }
  if (!(p.durationMinutes > 0)) {
    throw new Error("处方训练时长必须为正");
  }
}

export class PrescriptionRegistry {
  private readonly stored = new Map<string, Map<number, StoredPrescription>>();
  private readonly recalls = new Map<string, RecallMarker>();

  constructor(private readonly keyring: TherapistKeyring) {}

  /** 验签 → 校验 → 冻结 → 登记。返回的对象永不变更。 */
  publish(signed: SignedPrescription, publishedAt: Date): StoredPrescription {
    const p = signed.prescription;
    validate(p);
    verifyCanonical(p, signed.signature, this.keyring.get(signed.keyId));

    let versions = this.stored.get(p.prescriptionId);
    if (!versions) {
      versions = new Map();
      this.stored.set(p.prescriptionId, versions);
    }
    const existing = versions.get(p.version);
    if (existing) {
      throw new Error(`处方 ${p.prescriptionId} v${p.version} 已发布，内容不可改写`);
    }
    const maxVersion = versions.size === 0 ? 0 : Math.max(...versions.keys());
    if (p.version <= maxVersion) {
      throw new Error(`处方版本必须严格递增：当前最大 v${maxVersion}，收到 v${p.version}`);
    }

    const frozen: SignedPrescription = {
      prescription: deepFreeze(structuredClone(p)),
      signature: signed.signature,
      keyId: signed.keyId,
    };
    const stored: StoredPrescription = {
      signed: frozen,
      fingerprint: sha256Hex(canonicalJSON(p)),
      publishedAt,
    };
    versions.set(p.version, stored);
    return stored;
  }

  /** 治疗师侧便捷签发（私钥只在治疗师端持有）。 */
  sign(p: PrescriptionVersion, privateKey: KeyObject, keyId: string): SignedPrescription {
    const { signature } = signCanonical(p, privateKey, keyId);
    return { prescription: p, signature, keyId };
  }

  getSigned(prescriptionId: string, version: number): SignedPrescription {
    const stored = this.stored.get(prescriptionId)?.get(version);
    if (!stored) {
      throw new Error(`处方 ${prescriptionId} v${version} 未登记`);
    }
    return stored.signed;
  }

  fingerprint(prescriptionId: string, version: number): string {
    const stored = this.stored.get(prescriptionId)?.get(version);
    if (!stored) {
      throw new Error(`处方 ${prescriptionId} v${version} 未登记`);
    }
    return stored.fingerprint;
  }

  /** 开课校验：版本存在、在有效期内、未被撤回。 */
  assertUsable(prescriptionId: string, version: number, at: Date): SignedPrescription {
    const signed = this.getSigned(prescriptionId, version);
    const recall = this.recalls.get(prescriptionId);
    if (recall) {
      throw new Error(`处方 ${prescriptionId} 已于 ${recall.recalledAt.toISOString()} 撤回，不能开始新课程`);
    }
    const t = at.getTime();
    const p = signed.prescription;
    if (t < new Date(p.validFrom).getTime() || t >= new Date(p.validUntil).getTime()) {
      throw new Error(`处方 ${prescriptionId} v${version} 在 ${at.toISOString()} 不在有效期内`);
    }
    return signed;
  }

  recall(prescriptionId: string, reason: string, recalledAt: Date): RecallMarker {
    if (!this.stored.has(prescriptionId)) {
      throw new Error(`未知处方 ${prescriptionId}，无法撤回`);
    }
    const marker: RecallMarker = { reason, recalledAt };
    this.recalls.set(prescriptionId, marker);
    return marker;
  }

  isRecalled(prescriptionId: string): boolean {
    return this.recalls.has(prescriptionId);
  }
}
