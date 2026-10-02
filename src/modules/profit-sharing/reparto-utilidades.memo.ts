/**
 * UTILIDADES MENSUALES DE LOS SOCIOS — memo en memoria (v2, 2-oct-2026,
 * invariante 38). Lo usa `ProfitSharingService.utilidadesSociosPorMes`
 * (dueño de `compute`): el resumen de cuentas, el estado de cuenta, el
 * candado del saldo y el pre-cierre comparten la MISMA memoria.
 *
 * Reglas:
 *  - Un `compute(primer día, último día)` por MES calendario (los % con
 *    vigencia cambian por mes: jamás uno de todo el rango).
 *  - Meses CERRADOS (< mes en curso) se memoizan `ttlMs` (10 min): un cobro
 *    o gasto tardío de un mes cerrado se refleja a lo más 10 min después en
 *    las LECTURAS. Las ESCRITURAS de entregas (el candado del adelanto y su
 *    `saldo_snapshot_usd`) piden `fresco`: recalculan sin leer la memoria y
 *    la RENUEVAN (nadie llama `olvidar()` desde cobros ni gastos).
 *  - El mes EN CURSO jamás se memoiza (la cifra se mueve con cada cobro).
 *  - Como mucho `concurrencia` (3) computes a la vez.
 *  - Un fallo NO se memoiza (el siguiente pedido reintenta) y SUBE: nunca
 *    un número parcial.
 *  - «Mes en curso» lo decide quien llama (`mesActual`): un solo reloj.
 */
import { esMes } from './reparto-pago.util';
import type { UtilidadMesSocios } from './reparto-cuenta.util';

export const UTILIDADES_TTL_MS = 10 * 60_000;
export const UTILIDADES_CONCURRENCIA = 3;

interface Entrada {
  expiraMs: number;
  promesa: Promise<UtilidadMesSocios>;
}

export class UtilidadesMensualesSocios {
  private readonly memo = new Map<string, Entrada>();
  private readonly ttlMs: number;
  private readonly concurrencia: number;
  private readonly ahoraMs: () => number;

  constructor(
    /** compute del mes ⇒ utilidades por socio (`enCurso` ya resuelto). */
    private readonly calcular: (
      mes: string,
      enCurso: boolean,
    ) => Promise<UtilidadMesSocios>,
    opts: {
      ttlMs?: number;
      concurrencia?: number;
      ahoraMs?: () => number;
    } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? UTILIDADES_TTL_MS;
    this.concurrencia = Math.max(
      1,
      opts.concurrencia ?? UTILIDADES_CONCURRENCIA,
    );
    this.ahoraMs = opts.ahoraMs ?? (() => Date.now());
  }

  /**
   * Utilidades de esos meses, EN EL MISMO ORDEN. Un mes posterior a
   * `mesActual` es un error de programación (lanza). `fresco`: ignora lo
   * memoizado (lo recalcula y lo deja como la nueva memoria).
   */
  async deMeses(
    meses: ReadonlyArray<string>,
    mesActual: string,
    opts: { fresco?: boolean } = {},
  ): Promise<UtilidadMesSocios[]> {
    for (const m of meses) {
      if (!esMes(m) || m > mesActual) {
        throw new Error(`Mes de utilidades inválido o futuro: ${String(m)}`);
      }
    }
    const out = new Array<UtilidadMesSocios>(meses.length);
    let siguiente = 0;
    const trabajador = async () => {
      while (siguiente < meses.length) {
        const i = siguiente;
        siguiente += 1;
        out[i] = await this.deMes(meses[i], mesActual, opts.fresco === true);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrencia, meses.length) },
        trabajador,
      ),
    );
    return out;
  }

  /** Olvida todo lo memoizado (specs / después de un cambio masivo). */
  olvidar(): void {
    this.memo.clear();
  }

  private deMes(
    mes: string,
    mesActual: string,
    fresco: boolean,
  ): Promise<UtilidadMesSocios> {
    if (mes === mesActual) return this.calcular(mes, true);
    const ahora = this.ahoraMs();
    const hit = this.memo.get(mes);
    if (!fresco && hit && hit.expiraMs > ahora) return hit.promesa;
    const promesa = this.calcular(mes, false);
    const entrada: Entrada = { expiraMs: ahora + this.ttlMs, promesa };
    this.memo.set(mes, entrada);
    promesa.catch(() => {
      // Un fallo no se memoiza (solo si sigue siendo ESTA entrada).
      if (this.memo.get(mes) === entrada) this.memo.delete(mes);
    });
    return promesa;
  }
}
