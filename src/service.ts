import { PrescriptionRegistry } from "./prescriptions.ts";
import { SessionService } from "./sessions.ts";
import { DEFAULT_POLICY } from "./safety.ts";
import type { SafetyPolicy } from "./safety.ts";

/**
 * 康复训练安全服务门面：组合处方注册表与课程服务，
 * 保证“撤回处方”这类跨域动作对进行中的课程一致生效。
 */
export class RehabSafetyService {
  readonly prescriptions: PrescriptionRegistry;
  readonly sessions: SessionService;

  constructor(policy: SafetyPolicy = DEFAULT_POLICY) {
    this.prescriptions = new PrescriptionRegistry();
    this.sessions = new SessionService(this.prescriptions, policy);
  }

  /**
   * 撤回处方版本：
   * - 注册表标记撤回 → 新课程无法引用该版本；
   * - 进行中的课程收到停止指令与原因；
   * - 已结束的课程与其记录保持原样。
   */
  withdrawPrescription(prescriptionId: string, version: number, reason: string, at: string): string[] {
    this.prescriptions.withdraw(prescriptionId, version, reason, at);
    return this.sessions.stopSessionsForWithdrawal(prescriptionId, version, reason, at);
  }
}
