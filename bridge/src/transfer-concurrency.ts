export class TransferConcurrency {
  private active = 0;

  constructor(private readonly maximum: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.maximum) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  stats() {
    return { active: this.active, maximum: this.maximum };
  }
}
