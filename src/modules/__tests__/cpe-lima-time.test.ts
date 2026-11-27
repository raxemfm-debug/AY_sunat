import { describe, expect, it } from "vitest";
import { limaDateTime } from "../cpe/cpe-orchestrator.js";

describe("Fecha de emisión por defecto en hora de Lima (UTC-5)", () => {
  it("una venta a las 21:30 en Lima conserva la fecha local aunque en UTC ya sea el día siguiente", () => {
    expect(limaDateTime(new Date("2026-11-28T02:30:00Z"))).toEqual({ date: "2026-11-27", time: "21:30:00" });
  });

  it("al mediodía coincide la fecha y la hora se desplaza 5 horas", () => {
    expect(limaDateTime(new Date("2026-03-05T17:00:05Z"))).toEqual({ date: "2026-03-05", time: "12:00:05" });
  });

  it("cambia de año correctamente en la medianoche de Lima", () => {
    expect(limaDateTime(new Date("2027-01-01T04:59:59Z")).date).toBe("2026-12-31");
    expect(limaDateTime(new Date("2027-01-01T05:00:00Z")).date).toBe("2027-01-01");
  });
});
