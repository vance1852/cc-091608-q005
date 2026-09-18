import { readFileSync } from "node:fs";
import type { TelemetryEvent } from "./contracts.ts";

export interface FixtureEvent {
  eventId: string;
  capturedAt: string;
  receivedAt: string;
  heartRate?: number;
  symptom?: string;
}

export interface RehabFixture {
  sessionId: string;
  prescription: { id: string; version: number; validFrom: string };
  events: FixtureEvent[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** 解析并校验课程样例；临床数据入口必须显式校验，不接受隐式形状。 */
export function parseRehabFixture(raw: unknown): RehabFixture {
  if (!isObject(raw)) throw new Error("课程样例必须是 JSON 对象");
  const { sessionId, prescription, events } = raw;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("课程样例缺少 sessionId");
  }
  if (
    !isObject(prescription) ||
    typeof prescription.id !== "string" ||
    typeof prescription.version !== "number" ||
    typeof prescription.validFrom !== "string"
  ) {
    throw new Error("课程样例 prescription 字段不完整（需要 id/version/validFrom）");
  }
  if (!Array.isArray(events)) {
    throw new Error("课程样例 events 必须是数组");
  }
  const parsedEvents = events.map((rawEvent, index): FixtureEvent => {
    if (
      !isObject(rawEvent) ||
      typeof rawEvent.eventId !== "string" ||
      typeof rawEvent.capturedAt !== "string" ||
      typeof rawEvent.receivedAt !== "string"
    ) {
      throw new Error(`事件 #${index} 缺少 eventId/capturedAt/receivedAt`);
    }
    if (Number.isNaN(Date.parse(rawEvent.capturedAt)) || Number.isNaN(Date.parse(rawEvent.receivedAt))) {
      throw new Error(`事件 ${rawEvent.eventId} 时间戳无效`);
    }
    const event: FixtureEvent = {
      eventId: rawEvent.eventId,
      capturedAt: rawEvent.capturedAt,
      receivedAt: rawEvent.receivedAt,
    };
    if (rawEvent.heartRate !== undefined) {
      if (typeof rawEvent.heartRate !== "number") throw new Error(`事件 ${event.eventId} 心率必须是数字`);
      event.heartRate = rawEvent.heartRate;
    }
    if (rawEvent.symptom !== undefined) {
      if (typeof rawEvent.symptom !== "string") throw new Error(`事件 ${event.eventId} 症状必须是字符串`);
      event.symptom = rawEvent.symptom;
    }
    if (event.heartRate === undefined && event.symptom === undefined) {
      throw new Error(`事件 ${event.eventId} 既无心率也无症状`);
    }
    return event;
  });
  if (new Set(parsedEvents.map((e) => e.eventId)).size !== parsedEvents.length) {
    throw new Error("课程样例存在重复 eventId");
  }
  return {
    sessionId,
    prescription: { id: prescription.id, version: prescription.version, validFrom: prescription.validFrom },
    events: parsedEvents,
  };
}

export function loadRehabFixture(path: string | URL): RehabFixture {
  return parseRehabFixture(JSON.parse(readFileSync(path, "utf8")));
}

export function toTelemetry(event: FixtureEvent, sessionId: string): TelemetryEvent {
  return {
    eventId: event.eventId,
    sessionId,
    capturedAt: event.capturedAt,
    receivedAt: event.receivedAt,
    ...(event.heartRate !== undefined ? { heartRate: event.heartRate } : {}),
    ...(event.symptom !== undefined ? { symptom: event.symptom } : {}),
  };
}
