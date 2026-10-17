/**
 * NÓMINA SIN REPARTIR (16-oct-2026, API 0.0.90, invariante 91). Pedido del
 * cliente: «todo lo de nómina no se sume al gasto… repartir en partes
 * iguales a los aviones que yo elija… y ya solo así repartido y asignado se
 * vaya al balance del avión y al general». Una NÓMINA SIN ninguna fila en
 * `gasto_reparto` no entra a NINGÚN balance (hasta el 0.0.89 iba a «otros
 * gastos» del general por ser categoría de EMPRESA): se avisa en el
 * consolidado del Balance general y BLOQUEA el pre-cierre.
 *
 * PURO y FUENTE ÚNICA de las sumas y los TEXTOS de los dos avisos
 * (`aircraft-balance.service#payloadGeneral` y
 * `profit-sharing.service#preCierre`). Jamás suma monedas: pesos y dólares
 * por separado, en centavos enteros.
 */
import { fmtDineroTexto } from './dinero-texto.util';

/** Clave del renglón BLOQUEANTE del pre-cierre. */
export const CLAVE_PRECIERRE_NOMINA_SIN_REPARTIR = 'nomina_sin_repartir';
/** Título del renglón del pre-cierre. */
export const TITULO_PRECIERRE_NOMINA_SIN_REPARTIR =
  'Nómina sin repartir entre aviones';
/** Detalle con 0 pagos. */
export const DETALLE_PRECIERRE_NOMINA_REPARTIDA =
  'Toda la nómina del periodo está repartida.';
/** Detalle cuando la lectura de los repartos falló. */
export const DETALLE_PRECIERRE_NOMINA_SIN_VERIFICAR =
  'No se pudo verificar la nómina del periodo.';

/** Cuántos pagos y cuánto por moneda (MXN = todo lo que no es USD). */
export interface ResumenNominaSinRepartir {
  n: number;
  mxn: number;
  usd: number;
}

/** Σ en centavos enteros por moneda; un monto ilegible suma 0. */
export function resumenNominaSinRepartir(
  gastos: ReadonlyArray<{ monto?: unknown; moneda?: unknown }>,
): ResumenNominaSinRepartir {
  let mxn = 0;
  let usd = 0;
  for (const g of gastos) {
    const n = Number(g.monto);
    const cents = Number.isFinite(n) ? Math.round(n * 100) : 0;
    if (g.moneda === 'USD') usd += cents;
    else mxn += cents;
  }
  return { n: gastos.length, mxn: mxn / 100, usd: usd / 100 };
}

/** «$X MXN», «$X MXN y $Y USD» o «$Y USD» (solo dólares). */
export function textoMontosNomina(r: ResumenNominaSinRepartir): string {
  if (r.usd > 0 && r.mxn > 0) {
    return `${fmtDineroTexto(r.mxn, 'MXN')} y ${fmtDineroTexto(r.usd, 'USD')}`;
  }
  if (r.usd > 0) return fmtDineroTexto(r.usd, 'USD');
  return fmtDineroTexto(r.mxn, 'MXN');
}

const pagos = (n: number): string => (n === 1 ? '1 pago' : `${n} pagos`);

/**
 * Aviso del consolidado del Balance general (solo con N > 0): «Nómina sin
 * repartir: 3 pagos por $9,000 MXN — no entra a ningún balance hasta
 * repartirla entre aviones (módulo Nómina).»
 */
export function pendienteBalanceNominaSinRepartir(
  r: ResumenNominaSinRepartir,
): string | null {
  if (r.n <= 0) return null;
  return `Nómina sin repartir: ${pagos(r.n)} por ${textoMontosNomina(r)} — no entra a ningún balance hasta repartirla entre aviones (módulo Nómina).`;
}

/**
 * Detalle del renglón del pre-cierre: con pagos, cuántos y cuánto; 0 ⇒
 * «Toda la nómina del periodo está repartida.»; null (lectura caída) ⇒
 * «No se pudo verificar la nómina del periodo.».
 */
export function detallePrecierreNominaSinRepartir(
  r: ResumenNominaSinRepartir | null,
): string {
  if (!r) return DETALLE_PRECIERRE_NOMINA_SIN_VERIFICAR;
  if (r.n <= 0) return DETALLE_PRECIERRE_NOMINA_REPARTIDA;
  const uno = r.n === 1;
  return `${pagos(r.n)} de nómina por ${textoMontosNomina(r)} no ${uno ? 'se ha' : 'se han'} repartido entre aviones: no ${uno ? 'entra' : 'entran'} a ningún balance ni al reparto. ${uno ? 'Repártelo' : 'Repártelos'} en Nómina.`;
}
