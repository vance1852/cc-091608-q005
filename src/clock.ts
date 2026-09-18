/** 可替换时钟。回放时用 ManualClock 驱动到各 receivedAt，禁止读取系统时钟倒推。 */
export interface Clock {
  now(): Date;
}

export class ManualClock implements Clock {
  private current: Date;

  constructor(startIso: string) {
    this.current = new Date(startIso);
  }

  setTo(iso: string): void {
    const next = new Date(iso);
    if (next.getTime() < this.current.getTime()) {
      throw new Error(`时钟不得回退：${this.current.toISOString()} -> ${next.toISOString()}`);
    }
    this.current = next;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  now(): Date {
    return this.current;
  }
}
