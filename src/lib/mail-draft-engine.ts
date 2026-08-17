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
  | "DELETING"
  | "DISCARDING";

export class DraftEngine {
  private currentState: DraftEngineState = "HYDRATING";
  private userGen = 0;
  private savedGen = 0;
  private hydrationDependencies = new Set<string>();
  private hydrationSettled = false;
  private resourceDependencies = new Map<string, "pending" | "resolved" | "failed">();

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

  /** Initialize persisted local/remote generations before hydration settles. */
  restoreGenerations(localRevision: number, remoteCommittedRevision: number): void {
    if (this.currentState !== "HYDRATING") return;
    const local = Number.isSafeInteger(localRevision) && localRevision >= 0 ? localRevision : 0;
    const remote =
      Number.isSafeInteger(remoteCommittedRevision) && remoteCommittedRevision >= 0
        ? Math.min(local, remoteCommittedRevision)
        : 0;
    this.userGen = local;
    this.savedGen = remote;
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
    this.currentState = this.isDirty
      ? this.hasFailedDependencies()
        ? "FAILED"
        : this.hasPendingDependencies()
          ? "UPLOADING"
          : "DIRTY"
      : "CLEAN";
  }

  markUserEdit(): void {
    if (this.currentState === "DELETING" || this.currentState === "DISCARDING") return;
    if (this.currentState === "HYDRATING") {
      // User edits are not expected during hydration. Once the barrier
      // completes, the dirty state will still be calculated from generation.
    }
    const wasSaving = this.currentState === "SAVING";
    this.userGen += 1;
    if (wasSaving) return;
    this.currentState = this.hasFailedDependencies()
      ? "FAILED"
      : this.hasPendingDependencies()
        ? "UPLOADING"
        : "DIRTY";
  }

  markSaved(generation: number): void {
    if (generation > this.savedGen) this.savedGen = generation;
    if (this.currentState !== "DELETING" && this.currentState !== "DISCARDING") {
      this.currentState = this.isDirty
        ? this.hasFailedDependencies()
          ? "FAILED"
          : this.hasPendingDependencies()
            ? "UPLOADING"
            : "DIRTY"
        : "CLEAN";
    }
  }

  markSaveFailed(): void {
    if (this.currentState === "DELETING" || this.currentState === "DISCARDING") return;
    this.currentState = "FAILED";
  }

  beginSave(): boolean {
    if (
      this.currentState === "DELETING" ||
      this.currentState === "DISCARDING" ||
      this.currentState === "HYDRATING" ||
      this.currentState === "SAVING"
    )
      return false;
    if (!this.isDirty) return false;
    if (this.hasPendingDependencies()) return false;
    if (this.hasFailedDependencies()) return false;
    this.currentState = "SAVING";
    return true;
  }

  canCommitLatest(): boolean {
    return (
      this.currentState !== "HYDRATING" &&
      this.currentState !== "DELETING" &&
      this.currentState !== "DISCARDING" &&
      this.isDirty &&
      this.userGen > this.savedGen &&
      !this.hasPendingDependencies() &&
      !this.hasFailedDependencies() &&
      this.currentState !== "SAVING"
    );
  }

  registerResourceDependency(key: string): void {
    this.resourceDependencies.set(key, "pending");
    if (this.isDirty && this.currentState !== "HYDRATING") this.currentState = "UPLOADING";
  }

  resolveResourceDependency(key: string): void {
    if (!this.resourceDependencies.has(key)) return;
    this.resourceDependencies.set(key, "resolved");
    if (
      this.isDirty &&
      this.currentState !== "DELETING" &&
      this.currentState !== "DISCARDING" &&
      this.currentState !== "SAVING" &&
      this.currentState !== "HYDRATING"
    ) {
      this.currentState = this.hasFailedDependencies()
        ? "FAILED"
        : this.hasPendingDependencies()
          ? "UPLOADING"
          : "READY_TO_SAVE";
    }
  }

  failResourceDependency(key: string): void {
    if (!this.resourceDependencies.has(key)) return;
    this.resourceDependencies.set(key, "failed");
    if (
      this.currentState !== "DELETING" &&
      this.currentState !== "DISCARDING" &&
      this.currentState !== "HYDRATING"
    ) {
      this.currentState = "FAILED";
    }
  }

  cancelResourceDependency(key: string): void {
    if (!this.resourceDependencies.delete(key)) return;
    if (
      this.isDirty &&
      this.currentState !== "DELETING" &&
      this.currentState !== "DISCARDING" &&
      this.currentState !== "SAVING" &&
      this.currentState !== "HYDRATING"
    ) {
      this.currentState = this.hasFailedDependencies()
        ? "FAILED"
        : this.hasPendingDependencies()
          ? "UPLOADING"
          : "READY_TO_SAVE";
    }
  }

  /** @deprecated Compatibility wrapper; ownership is resource-scoped, not generation-scoped. */
  registerAttachmentDependency(generation: number, key: string): void {
    void generation;
    this.registerResourceDependency(key);
  }

  resolveAttachmentDependency(generation: number, key: string): void {
    void generation;
    this.resolveResourceDependency(key);
  }

  failAttachmentDependency(generation: number, key: string): void {
    void generation;
    this.failResourceDependency(key);
  }

  cancelAttachmentDependency(generation: number, key: string): void {
    void generation;
    this.cancelResourceDependency(key);
  }

  hasPendingDependencies(): boolean {
    for (const value of this.resourceDependencies.values()) if (value === "pending") return true;
    return false;
  }

  hasPendingDependenciesFor(generation: number): boolean {
    void generation;
    return this.hasPendingDependencies();
  }

  hasFailedDependenciesFor(generation: number): boolean {
    void generation;
    return this.hasFailedDependencies();
  }

  hasFailedDependencies(): boolean {
    for (const value of this.resourceDependencies.values()) {
      if (value === "failed") return true;
    }
    return false;
  }

  beginDelete(): void {
    this.currentState = "DELETING";
  }

  beginDiscard(): void {
    this.currentState = "DISCARDING";
  }

  completeDeleteFailure(): void {
    if (this.currentState !== "DELETING" && this.currentState !== "DISCARDING") return;
    this.currentState = this.isDirty
      ? this.hasFailedDependencies()
        ? "FAILED"
        : this.hasPendingDependencies()
          ? "UPLOADING"
          : "DIRTY"
      : "CLEAN";
  }

  resetForDiscard(): void {
    this.savedGen = this.userGen;
    this.currentState = "CLEAN";
  }
}
