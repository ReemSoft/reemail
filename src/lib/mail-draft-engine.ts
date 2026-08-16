/**
 * Centralized Draft lifecycle owner for the Composer.
 *
 * The Composer still renders fields and owns UI, but generation/dirty/hydration
 * and attachment-dependency eligibility are decided here so multiple React
 * effects cannot accidentally produce Draft commits.
 */

export type DraftEngineState =
  | "HYDRATING"
  | "CLEAN"
  | "DIRTY"
  | "UPLOADING"
  | "READY_TO_SAVE"
  | "SAVING"
  | "FAILED"
  | "DELETING";

export class DraftEngine {
  private currentState: DraftEngineState = "HYDRATING";
  private userGen = 0;
  private savedGen = 0;
  private hydrationDependencies = new Set<string>();
  private hydrationSettled = false;
  private attachmentDependencies = new Map<number, Map<string, "pending" | "resolved" | "failed">>();

  get state(): DraftEngineState {
    return this.currentState;
  }

  get userGeneration(): number {
    return this.userGen;
  }

  get savedGeneration(): number {
    return this.savedGen;
  }

  get isDirty(): boolean {
    return this.userGen > this.savedGen;
  }

  get isHydrating(): boolean {
    return this.currentState === "HYDRATING";
  }

  beginHydration(): void {
    this.currentState = "HYDRATING";
    this.hydrationSettled = false;
  }

  registerHydrationDependency(key: string): void {
    if (this.currentState !== "HYDRATING") return;
    this.hydrationDependencies.add(key);
  }

  settleHydrationDependency(key: string): void {
    this.hydrationDependencies.delete(key);
  }

  completeHydrationWhenReady(): void {
    if (this.currentState !== "HYDRATING") return;
    if (this.hydrationDependencies.size > 0) return;
    this.hydrationSettled = true;
    this.currentState = this.isDirty ? "DIRTY" : "CLEAN";
  }

  markUserEdit(): void {
    if (this.currentState === "DELETING") return;
    if (this.currentState === "HYDRATING") {
      // User edits are not expected during hydration. Once the barrier
      // completes, the dirty state will still be calculated from generation.
    }
    this.userGen += 1;
    this.currentState = this.hasPendingDependenciesFor(this.userGen)
      ? "UPLOADING"
      : "DIRTY";
  }

  markSaved(generation: number): void {
    if (generation > this.savedGen) this.savedGen = generation;
    for (const key of [...this.attachmentDependencies.keys()]) {
      if (key <= generation) this.attachmentDependencies.delete(key);
    }
    if (this.currentState !== "DELETING") {
      this.currentState = this.isDirty
        ? this.hasPendingDependenciesFor(this.userGen)
          ? "UPLOADING"
          : "DIRTY"
        : "CLEAN";
    }
  }

  markSaveFailed(): void {
    if (this.currentState === "DELETING") return;
    this.currentState = "FAILED";
  }

  beginSave(): boolean {
    if (this.currentState === "DELETING" || this.currentState === "HYDRATING") return false;
    if (!this.isDirty) return false;
    if (this.hasPendingDependenciesFor(this.userGen)) return false;
    if (this.hasFailedDependenciesFor(this.userGen)) return false;
    this.currentState = "SAVING";
    return true;
  }

  canCommitLatest(): boolean {
    return (
      this.currentState !== "HYDRATING" &&
      this.currentState !== "DELETING" &&
      this.isDirty &&
      this.userGen > this.savedGen &&
      !this.hasPendingDependenciesFor(this.userGen) &&
      !this.hasFailedDependenciesFor(this.userGen) &&
      this.currentState !== "SAVING"
    );
  }

  registerAttachmentDependency(generation: number, key: string): void {
    const keys = this.attachmentDependencies.get(generation) ?? new Map<string, "pending" | "resolved" | "failed">();
    keys.set(key, "pending");
    this.attachmentDependencies.set(generation, keys);
    if (generation === this.userGen && this.isDirty) {
      this.currentState = "UPLOADING";
    }
  }

  resolveAttachmentDependency(generation: number, key: string): void {
    const keys = this.attachmentDependencies.get(generation);
    if (!keys) return;
    keys.set(key, "resolved");
    if (
      generation === this.userGen &&
      this.isDirty &&
      this.currentState !== "DELETING" &&
      this.currentState !== "SAVING" &&
      this.currentState !== "HYDRATING"
    ) {
      this.currentState = this.hasPendingDependenciesFor(generation)
        ? "UPLOADING"
        : "READY_TO_SAVE";
    }
  }

  failAttachmentDependency(generation: number, key: string): void {
    const keys = this.attachmentDependencies.get(generation);
    if (!keys) return;
    keys.set(key, "failed");
    if (generation === this.userGen && this.currentState !== "DELETING") {
      this.currentState = "FAILED";
    }
  }

  cancelAttachmentDependency(generation: number, key: string): void {
    const keys = this.attachmentDependencies.get(generation);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.attachmentDependencies.delete(generation);
    if (
      generation === this.userGen &&
      this.isDirty &&
      this.currentState !== "DELETING" &&
      this.currentState !== "SAVING" &&
      this.currentState !== "HYDRATING"
    ) {
      this.currentState = this.hasPendingDependenciesFor(generation)
        ? "UPLOADING"
        : "READY_TO_SAVE";
    }
  }

  hasPendingDependencies(): boolean {
    return this.hasPendingDependenciesFor(this.userGen);
  }

  hasPendingDependenciesFor(generation: number): boolean {
    const keys = this.attachmentDependencies.get(generation);
    if (!keys) return false;
    for (const value of keys.values()) {
      if (value === "pending") return true;
    }
    return false;
  }

  hasFailedDependenciesFor(generation: number): boolean {
    const keys = this.attachmentDependencies.get(generation);
    if (!keys) return false;
    for (const value of keys.values()) {
      if (value === "failed") return true;
    }
    return false;
  }

  beginDelete(): void {
    this.currentState = "DELETING";
  }

  completeDeleteFailure(): void {
    if (this.currentState !== "DELETING") return;
    this.currentState = this.isDirty ? "DIRTY" : "CLEAN";
  }

  resetForDiscard(): void {
    this.savedGen = this.userGen;
    this.currentState = "CLEAN";
  }
}
