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
