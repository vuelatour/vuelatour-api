/**
 * PRE-CIERRE → «Vuelos cobrados de más» (14-oct-2026, API 0.0.78,
 * invariante 77, D14). Renglón NO bloqueante (`bloqueantes`/`listo` no
 * cambian) que va JUSTO DESPUÉS de `cobros_pendientes`, con el MISMO
 * universo (completados del periodo, sin clientes internos) y la MISMA
 * cadena de T.C. (`convCobros`: cotización ?? oficial del día). La regla es
 * `common/cobrado-de-mas.util#cobradoDeMas` SIN la causa
 * OTRO_VUELO_DEL_CLIENTE (esa lectura es solo del snapshot, best-effort).
 *
 * Por qué sí avisa: el excedente no es cosmético — el balance lo manda a
 * «otros movimientos» de VuelaTour y la parte del avión se topa
 * (`cobradoParteAvion`), así que un IVA no cotizado o un error de captura
 * mueve dinero del avión a VuelaTour justo en el cierre. Por qué no bloquea:
 * el dinero sí entró y el reparto lo cuenta.
 *
 * `count` = SOLO los que requieren revisión; los explicados (comisión del
 * link pagada por el cliente, redondeo del T.C.) viajan aparte en
 * `explicados[]` y el panel los pinta en una línea gris «Además: …». Cada
 * chip lleva `saldo_usd` (= el excedente, para el renderizador genérico).
 * Helper PURO: el cálculo por vuelo lo hace `profit-sharing.service`.
 */
import type {
  CausaCobradoDeMas,
  CobradoDeMas,
} from '../../common/cobrado-de-mas.util';

export const CLAVE_PRECIERRE_COBRADOS_DE_MAS = 'vuelos_cobrados_de_mas';

export const TITULO_PRECIERRE_COBRADOS_DE_MAS = 'Vuelos cobrados de más';

export const DETALLE_PRECIERRE_COBRADOS_DE_MAS =
  'Lo cobrado rebasa el total del vuelo por más de $1.00 USD y la diferencia no se explica sola: IVA que la cotización no lleva, un cobro capturado dos veces o un depósito de otro vuelo. Revisa la card de cobros de cada vuelo. No bloquea el cierre, pero el excedente se reparte como ingreso de VuelaTour.';

/** La frase de los explicados (solo con alguno). */
export function detalleExplicadosCobradosDeMas(n: number): string {
  return n === 1
    ? ' Además hay 1 vuelo con la diferencia explicada (comisión del link pagada por el cliente o redondeo del tipo de cambio) que no requiere acción.'
    : ` Además hay ${n} vuelos con la diferencia explicada (comisión del link pagada por el cliente o redondeo del tipo de cambio) que no requieren acción.`;
}

/** Un vuelo del periodo con su «cobrado de más» (null = sin aviso). */
export interface VueloConCobradoDeMas {
  id: string;
  folio: number;
  grupo_folio: number | null;
  cobrado: CobradoDeMas | null;
}

/**
 * Chip del checklist (mismo shape que `cobros_pendientes` + la causa). `type`
 * y no `interface`: los items del pre-cierre se leen como
 * `Record<string, unknown>` (una interface no tiene firma de índice).
 */
export type VueloCobradoDeMasPrecierre = {
  id: string;
  folio: number;
  /** = `excedente_usd` (el renderizador genérico de chips lee `saldo_usd`). */
  saldo_usd: number;
  excedente_usd: number;
  causa: CausaCobradoDeMas;
  causa_etiqueta: string;
  grupo_folio: number | null;
};

export type RenglonCobradosDeMas = {
  clave: typeof CLAVE_PRECIERRE_COBRADOS_DE_MAS;
  titulo: string;
  detalle: string;
  /** Solo los que requieren revisión. */
  count: number;
  /** Σ excedentes de los que requieren revisión (USD). */
  monto_usd: number;
  vuelos: VueloCobradoDeMasPrecierre[];
  explicados: VueloCobradoDeMasPrecierre[];
  explicados_n: number;
};

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function chip(
  v: VueloConCobradoDeMas,
  c: CobradoDeMas,
): VueloCobradoDeMasPrecierre {
  return {
    id: v.id,
    folio: v.folio,
    saldo_usd: c.excedente_usd,
    excedente_usd: c.excedente_usd,
    causa: c.causa,
    causa_etiqueta: c.causa_etiqueta,
    grupo_folio: v.grupo_folio,
  };
}

/**
 * El renglón con los vuelos que cobraron de más: los que requieren revisión
 * en `vuelos` (cuentan) y los explicados aparte; los dos por folio.
 */
export function renglonVuelosCobradosDeMas(
  lista: ReadonlyArray<VueloConCobradoDeMas>,
): RenglonCobradosDeMas {
  const ordenados = [...lista].sort((a, b) => a.folio - b.folio);
  const vuelos: VueloCobradoDeMasPrecierre[] = [];
  const explicados: VueloCobradoDeMasPrecierre[] = [];
  for (const v of ordenados) {
    if (!v.cobrado) continue;
    (v.cobrado.requiere_revision ? vuelos : explicados).push(
      chip(v, v.cobrado),
    );
  }
  return {
    clave: CLAVE_PRECIERRE_COBRADOS_DE_MAS,
    titulo: TITULO_PRECIERRE_COBRADOS_DE_MAS,
    detalle:
      DETALLE_PRECIERRE_COBRADOS_DE_MAS +
      (explicados.length > 0
        ? detalleExplicadosCobradosDeMas(explicados.length)
        : ''),
    count: vuelos.length,
    monto_usd: r2(vuelos.reduce((acc, v) => acc + v.excedente_usd, 0)),
    vuelos,
    explicados,
    explicados_n: explicados.length,
  };
}
