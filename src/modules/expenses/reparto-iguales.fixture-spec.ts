/**
 * Nómina REAL de octubre 2026 en prod (12 pagos, $109,921.46 MXN; SELECT
 * por MCP del 16-oct-2026, solo id corto, fecha y monto). La comparten
 * `reparto-iguales.util.spec` y `expenses.service.reparto-iguales.spec`.
 * `*-spec.ts` (sin punto) ⇒ fuera del build y fuera de jest.
 */
export const NOMINA_OCTUBRE_2026: ReadonlyArray<{
  id: string;
  fecha_gasto: string;
  monto: number;
}> = [
  { id: 'f907e6fe', fecha_gasto: '2026-10-07', monto: 5663.86 },
  { id: 'c13a9a43', fecha_gasto: '2026-10-14', monto: 5000 },
  { id: '228044ad', fecha_gasto: '2026-10-15', monto: 17500 },
  { id: '24fa36da', fecha_gasto: '2026-10-15', monto: 1910.6 },
  { id: '38baca3a', fecha_gasto: '2026-10-15', monto: 3565.8 },
  { id: '4096f35c', fecha_gasto: '2026-10-15', monto: 4725.6 },
  { id: '4201854f', fecha_gasto: '2026-10-15', monto: 2500 },
  { id: '4d3e1a5f', fecha_gasto: '2026-10-15', monto: 6830 },
  { id: '71e15a16', fecha_gasto: '2026-10-15', monto: 7500 },
  { id: 'b781cf03', fecha_gasto: '2026-10-15', monto: 4725.6 },
  { id: 'e0e069f3', fecha_gasto: '2026-10-15', monto: 27500 },
  { id: 'efdc0f5a', fecha_gasto: '2026-10-15', monto: 22500 },
];
