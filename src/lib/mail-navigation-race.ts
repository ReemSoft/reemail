export class NavigationGeneration {
  private value = 0;

  next(): number {
    this.value++;
    return this.value;
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }

  invalidate(): void {
    this.value++;
  }
}

export interface MessageOpenIntent {
  scope: string;
  generation: number;
}

type ScopeFactory = () => string;

function defaultScope(): string {
  return globalThis.crypto.randomUUID();
}

/** Generates operation identity without timers, I/O, or retained promises. */
export class MessageOpenIntentGeneration {
  private readonly scopeFactory: ScopeFactory;
  private scope: string;
  private generation = 0;
  private lastMessageId: string | null = null;

  constructor(scopeOrFactory: string | ScopeFactory = defaultScope) {
    this.scopeFactory = typeof scopeOrFactory === "function" ? scopeOrFactory : defaultScope;
    this.scope = typeof scopeOrFactory === "string" ? scopeOrFactory : scopeOrFactory();
  }

  next(messageId: string): MessageOpenIntent {
    if (messageId !== this.lastMessageId) {
      this.generation++;
      this.lastMessageId = messageId;
    }
    return { scope: this.scope, generation: this.generation };
  }

  resetScope(): void {
    this.scope = this.scopeFactory();
    this.generation = 0;
    this.lastMessageId = null;
  }
}
