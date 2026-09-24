/**
 * DINERO EN TEXTOS DEL API (24-sep-2026) — notificaciones, mensajes de
 * avisos y títulos. Regla ÚNICA acordada con el panel (`lib/format.ts`
 * `fmtUsd`/`fmtMonto`): **el dinero NUNCA se escribe con 1 decimal**.
 *
 *  - Se redondea a centavos.
 *  - Entero ⇒ sin decimales («$1,200»).
 *  - Con centavos ⇒ EXACTAMENTE 2 («$8,050.40», nunca «$8,050.4»).
 *  - `-0` (o un resto de redondeo) se escribe `$0`.
 *
 * La captura del audio de Itzi (24-sep-2026) decía «Cobrado $8,050.4 de
 * $8,050.4» y «$136,856.8 MXN»: un monto con un decimal parece un error de
 * captura aunque sea exacto.
 */

/** Redondeo a centavos que no se cae con 1.005 (mismo truco que `round2`). */
function aCentavos(n: number): number {
  const r = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  return n < 0 ? -r : r;
}

/**
 * Número de dinero SIN signo de pesos ni moneda: «8,050.40» · «1,200» ·
 * «0». Lo usan los títulos que ya ponen el `$` en su plantilla
 * (`semaforo-cobro.util`). Un valor no finito se escribe «0».
 */
export function fmtNumeroDinero(n: number): string {
  if (!Number.isFinite(n)) return '0';
  let r = aCentavos(n);
  if (r === 0) r = 0; // -0 ⇒ 0
  const entero = Number.isInteger(r);
  const cuerpo = Math.abs(r).toLocaleString('en-US', {
    minimumFractionDigits: entero ? 0 : 2,
    maximumFractionDigits: entero ? 0 : 2,
  });
  return r < 0 ? `-${cuerpo}` : cuerpo;
}

/**
 * «$8,050.40 USD» · «$1,200 MXN» · «$0» (sin moneda si no se pasa). El
 * signo va antes del `$` («-$250 USD»), como lo pinta el panel.
 */
export function fmtDineroTexto(n: number, moneda?: string | null): string {
  const num = fmtNumeroDinero(n);
  const conSigno = num.startsWith('-') ? `-$${num.slice(1)}` : `$${num}`;
  const m = (moneda ?? '').trim();
  return m ? `${conSigno} ${m}` : conSigno;
}
