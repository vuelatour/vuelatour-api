/**
 * EDICIÓN DE UNA COTIZACIÓN CON COBROS (26-sep-2026, API 0.0.37) — textos
 * PUROS del permiso especial `editores_cotizacion_cobrada`.
 *
 * Pedido de Alejandro y Pablo Canales (WhatsApp, cotizaciones #305 y #317):
 * «un vuelo que se cobró en efectivo pero estaba cotizado como para
 * transferencia, entonces tenía IVA: decía 754 dólares, pero entró el cobro
 * en efectivo por 600 dólares. Quiero editar para quitarle el IVA, porque si
 * no dice que es un cobro parcial… Yo necesito que eso se desbloquee para
 * mí, no para todos».
 *
 * Reglas (fuente única, con spec):
 * - Los COBROS no se tocan: solo cambia el total de la cotización; el saldo
 *   se recalcula con lo que ya se cobró (`cobrosEnUsd`, la misma fuente de
 *   la bandera `cobrado`). El ingreso del vuelo sigue saliendo de los cobros.
 * - El motivo de la versión lleva el prefijo `PREFIJO_MOTIVO_CON_COBROS`
 *   (una sola vez) para que el historial de versiones delate la excepción.
 * - El aviso ámbar dice cobrado, nuevo total y saldo — o SOBRECOBRO si lo
 *   cobrado rebasa el total —, siempre en USD con 2 decimales o sin ellos
 *   (`fmtDineroTexto`: el dinero nunca con 1 decimal).
 * - Hasta 1 USD de diferencia (en cualquier sentido) es REDONDEO, no deuda
 *   ni sobrecobro: MISMA tolerancia que la bandera `cobrado`
 *   (`refreshCobradoFlag`: cobrado ≥ total − 1), el semáforo
 *   (`semaforo-cobro.util#pendienteCobro`) y el diálogo «Guardar vN» del
 *   panel. Revisión adversaria 26-sep-2026: con la resta exacta, un total de
 *   $600.50 contra $600 cobrados salía «Pagado» en el semáforo y
 *   «liquidada» en el diálogo del panel, pero el aviso decía «saldo $0.50
 *   USD». La diferencia de redondeo se DICE (jamás desaparece en silencio).
 */
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import { pendienteCobro } from '../../common/semaforo-cobro.util';

/** Prefijo del motivo de la versión guardada con el permiso especial. */
export const PREFIJO_MOTIVO_CON_COBROS = '[Con cobros · permiso especial] ';

/** Motivo con el prefijo, sin duplicarlo si ya venía (reintento, panel). */
export function motivoConCobros(motivo: string): string {
  const m = (motivo ?? '').trim();
  const prefijo = PREFIJO_MOTIVO_CON_COBROS.trim();
  if (m.startsWith(prefijo)) return m;
  return `${PREFIJO_MOTIVO_CON_COBROS}${m}`;
}

/** Centavos exactos (mismo truco que `round2`: 1.005 no se cae). */
function round2(n: number): number {
  const r = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  return n < 0 ? -r : r;
}

export interface SaldoTrasEdicion {
  /** Neto cobrado en USD (`cobrosEnUsd`). */
  cobrado_usd: number;
  /** Total NUEVO de la cotización (`vuelo.monto_total_usd` tras guardar). */
  total_usd: number;
  /**
   * total − cobrado cuando falta MÁS de la tolerancia de redondeo (1 USD,
   * `pendienteCobro`); si no, 0.
   */
  saldo_usd: number;
  /**
   * cobrado − total cuando lo cobrado rebasa el total en MÁS de la
   * tolerancia de redondeo; si no, 0.
   */
  sobrecobro_usd: number;
  /**
   * |total − cobrado| cuando la diferencia es > 0 pero cabe en la
   * tolerancia (redondeo, no deuda ni sobrecobro); si no, 0.
   */
  redondeo_usd: number;
}

/**
 * Saldo o sobrecobro tras la edición: UNA resta a centavos, con la MISMA
 * tolerancia de redondeo que la bandera `cobrado` y el semáforo
 * (`pendienteCobro`, en los dos sentidos, igual que el panel).
 */
export function saldoTrasEdicion(
  cobradoUsd: number,
  totalUsd: number,
): SaldoTrasEdicion {
  const cobrado = round2(Number(cobradoUsd) || 0);
  const total = round2(Number(totalUsd) || 0);
  const dif = round2(total - cobrado);
  const saldo = pendienteCobro(total, cobrado);
  const sobrecobro = pendienteCobro(cobrado, total);
  return {
    cobrado_usd: cobrado,
    total_usd: total,
    saldo_usd: saldo,
    sobrecobro_usd: sobrecobro,
    redondeo_usd: saldo === 0 && sobrecobro === 0 ? Math.abs(dif) : 0,
  };
}

/**
 * «Se editó con cobros registrados: cobrado $600 USD, nuevo total $650 USD,
 * saldo $50 USD.» · «…, sobrecobro $50 USD.» · dentro de la tolerancia:
 * «…, saldo $0 USD (diferencia de redondeo de $0.50 USD).» Los cobros MXN
 * sin tipo de cambio no entran a la cuenta y se dicen aparte (jamás
 * desaparecen).
 */
export function avisoEdicionConCobros(p: {
  cobradoUsd: number;
  totalUsd: number;
  sinTcCount?: number;
  sinTcMxn?: number;
}): string {
  const s = saldoTrasEdicion(p.cobradoUsd, p.totalUsd);
  const redondeo =
    s.redondeo_usd > 0
      ? ` (diferencia de redondeo de ${fmtDineroTexto(s.redondeo_usd, 'USD')})`
      : '';
  const cola =
    s.sobrecobro_usd > 0
      ? `sobrecobro ${fmtDineroTexto(s.sobrecobro_usd, 'USD')}`
      : `saldo ${fmtDineroTexto(s.saldo_usd, 'USD')}${redondeo}`;
  const n = Number(p.sinTcCount) || 0;
  const sinTc =
    n > 0
      ? ` Además hay ${n} cobro${n === 1 ? '' : 's'} en MXN sin tipo de cambio (${fmtDineroTexto(Number(p.sinTcMxn) || 0, 'MXN')}) que no entra${n === 1 ? '' : 'n'} en esta cuenta.`
      : '';
  return `Se editó con cobros registrados: cobrado ${fmtDineroTexto(s.cobrado_usd, 'USD')}, nuevo total ${fmtDineroTexto(s.total_usd, 'USD')}, ${cola}. Los cobros no se modificaron.${sinTc}`;
}

/**
 * Aviso para un avión de GRUPO cuyos cobros vienen del sobre del grupo: la
 * revisión cambia el total de ESTE avión, pero el sobre ya se partió con los
 * totales viejos y no se re-parte solo.
 */
export const AVISO_EDICION_CON_COBROS_GRUPO =
  'Este avión es parte de un grupo y sus cobros vienen del sobre del grupo: el sobre NO se re-parte solo. Si el saldo entre aviones quedó disparejo, usa «Re-partir» en los cobros del grupo.';

/**
 * Cola del 409 `COTIZACION_COBRADA` para quien NO tiene el permiso: nombra a
 * quién sí puede editarla. Sin nombres (lista vacía o ilegible) ⇒ `''` y el
 * mensaje queda como siempre.
 */
export function textoQuienPuedeEditar(nombres: string[]): string {
  const limpios = nombres.map((n) => n.trim()).filter((n) => n.length > 0);
  if (limpios.length === 0) return '';
  return ` Solo pueden editarla: ${limpios.join(', ')}.`;
}
