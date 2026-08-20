import { describe, expect, it } from "vitest";
import {
  DELIVERY_PROGRESS_CAP,
  DELIVERY_PROGRESS_START,
  deliveryProgressForElapsed,
} from "../mail-send-progress";

describe("deliveryProgressForElapsed", () => {
  it("moves during a long SMTP request without claiming completion", () => {
    expect(deliveryProgressForElapsed(0)).toBe(DELIVERY_PROGRESS_START);
    expect(deliveryProgressForElapsed(5_000)).toBeGreaterThan(DELIVERY_PROGRESS_START);
    expect(deliveryProgressForElapsed(20_000)).toBeGreaterThan(deliveryProgressForElapsed(5_000));
    expect(deliveryProgressForElapsed(120_000)).toBeLessThanOrEqual(DELIVERY_PROGRESS_CAP);
  });

  it("does not move backwards for invalid elapsed input", () => {
    expect(deliveryProgressForElapsed(-1)).toBe(DELIVERY_PROGRESS_START);
  });
});
