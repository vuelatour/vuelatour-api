/**
 * PRE-CIERRE → «Vuelos completados sin gasto de operaciones» (5-oct-2026).
 *
 * Pregunta del cliente: «la conciliación no tiene pendientes, pero en el
 * balance por avión hay vuelos sin ningún gasto: ¿cómo confío en el
 * cierre?». La conciliación prueba que cada MOVIMIENTO DEL BANCO tiene su
 * gasto; no puede ver un gasto que nunca se capturó y que nunca pasó por la
 * tarjeta (efectivo del piloto, pago en ventanilla…). Casos reales: #295
 * (ACP, 12-sep, XA-VGV, CUN→PPS→CUN, cobrado, 0 gastos) y #268 (7-sep,
 * N4142R, CUN→CUN, 0 gastos); en agosto #142, #194 y #206 traían UN gasto,
 * ninguno de pista, y #136 (CET→CUN, cliente interno) tampoco. Este renglón
 * cierra el hueco desde el lado del VUELO.
 *
 * Universo: vuelos COMPLETADO del periodo, PROPIOS (no `es_externo`, con
 * `aeronave_id`). **Incluye cliente interno y vuelos de servicio**
 * (revisión 5-oct-2026): lo que importa aquí es el COSTO, no el cobro — su
 * pista resta en el balance por avión y en el reparto igual que la de un
 * vuelo de cliente. En prod, de los 14 de ago-sep que una exclusión habría
 * escondido, 13 traían su pista y el único sin ella (#136) era un gasto
 * faltante de verdad. Un vuelo cuenta como «sin gasto» si NO existe ningún
 * gasto con `vuelo_id` = el vuelo y categoría `OPERACIONES`/`ATERRIZAJE` —
 * la FECHA del gasto no importa (la cuota de pista se paga días después y
 * puede caer en otro mes).
 *
 * Aviso NO bloqueante. No hay forma de descartarlo: el vuelo sigue en la
 * lista mientras no tenga un gasto de pista ligado (marcar «sin cargo
 * confirmado» exigiría una columna nueva; fuera de alcance).
 *
 * Helpers PUROS: la consulta vive en `profit-sharing.service`
 * (`vuelosSinGastoOperaciones`); aquí solo el universo y la respuesta.
 */

export const CLAVE_PRECIERRE_VUELOS_SIN_GASTO = 'vuelos_sin_gasto_operaciones';

export const TITULO_PRECIERRE_VUELOS_SIN_GASTO =
  'Vuelos completados sin gasto de operaciones';

export const DETALLE_PRECIERRE_VUELOS_SIN_GASTO =
  'Vuelos propios COMPLETADOS del periodo (también los de cliente interno y los de servicio) sin ningún gasto de OPERACIONES/ATERRIZAJE (pista, plataforma, aterrizaje). La conciliación no puede verlos: el piloto no capturó el gasto o se pagó fuera de la tarjeta. Captura el gasto en el vuelo: el aviso no bloquea el cierre, pero el vuelo sigue en esta lista mientras no tenga uno.';

/** Texto cuando la lectura FALLÓ: el 0 no significa «no hay». */
export const DETALLE_PRECIERRE_VUELOS_SIN_GASTO_FALLIDA =
  'No se pudo verificar si a los vuelos completados del periodo les falta el gasto de operaciones: revisa los gastos de cada vuelo antes de cerrar.';

/** Categorías que cuentan como «gasto de operaciones» (pista/aterrizaje). */
export const CATEGORIAS_GASTO_OPERACIONES: readonly string[] = [
  'OPERACIONES',
  'ATERRIZAJE',
];

/** Vuelo COMPLETADO del periodo, tal como lo lee el pre-cierre. */
export interface VueloCompletadoSinGastoRow {
  id?: unknown;
  folio?: unknown;
  fecha_vuelo?: unknown;
  aeronave_id?: unknown;
  es_externo?: unknown;
}

/** Chip del checklist (mismo shape que los demás + `matricula` aditiva). */
export interface VueloSinGastoOperaciones {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  matricula: string | null;
}

/**
 * Candidatos a revisar: los PROPIOS (no externos y con avión), sin importar
 * el cliente (interno incluido) ni si es vuelo de servicio.
 */
export function candidatosSinGastoOperaciones<
  T extends VueloCompletadoSinGastoRow,
>(completados: ReadonlyArray<T>): T[] {
  return completados.filter(
    (v) =>
      typeof v.id === 'string' &&
      v.es_externo !== true &&
      v.aeronave_id != null,
  );
}

/**
 * Los candidatos que no tienen ningún gasto de operaciones ligado,
 * ordenados por `fecha_vuelo` (empate por folio; sin fecha, al final).
 */
export function vuelosSinGastoOperaciones(args: {
  candidatos: ReadonlyArray<VueloCompletadoSinGastoRow>;
  /** `vuelo_id` de los gastos OPERACIONES/ATERRIZAJE ligados. */
  vuelosConGasto: ReadonlySet<string>;
  /** aeronave.id → matrícula (lo que no resuelva sale `null`). */
  matriculas: ReadonlyMap<string, string>;
}): VueloSinGastoOperaciones[] {
  const out: VueloSinGastoOperaciones[] = [];
  for (const v of args.candidatos) {
    const id = v.id as string;
    if (args.vuelosConGasto.has(id)) continue;
    out.push({
      id,
      folio: Number(v.folio ?? 0),
      fecha_vuelo: typeof v.fecha_vuelo === 'string' ? v.fecha_vuelo : null,
      matricula:
        typeof v.aeronave_id === 'string'
          ? (args.matriculas.get(v.aeronave_id) ?? null)
          : null,
    });
  }
  const ms = (f: string | null) => {
    const t = f ? Date.parse(f) : NaN;
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  return out.sort(
    (a, b) => ms(a.fecha_vuelo) - ms(b.fecha_vuelo) || a.folio - b.folio,
  );
}
