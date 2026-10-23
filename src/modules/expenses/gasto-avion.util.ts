/**
 * COLUMNA «AVIÓN» DEL EXCEL DE GASTOS (`GET /v1/expenses/export`,
 * `listXlsx`) = la columna «Avión · vuelo» de la tabla de Gastos del panel
 * (hallazgo #20 de la revisión del panel de Gastos, 14-oct-2026). PURO, con
 * spec (`gasto-avion.util.spec.ts`) y PARIDAD contra la fuente única del
 * panel, `vuelatour-next/src/lib/admin/gasto-avion.ts#estadoAvionGasto`
 * (`gasto-avion.paridad.spec.ts` la EJECUTA si el repo hermano está al lado).
 *
 * Antes el Excel escribía «Repartido (N)», la matrícula o «(pendiente)» y la
 * tabla del panel «Repartido: …», «Personal», «VuelaTour» o «Falta avión».
 * En prod (15-oct-2026, 1,144 gastos) cambian 296 celdas: 199 de empresa o
 * de comisión (VuelaTour) sin avión y 5 INDIRECTO sin avión decían
 * «(pendiente)» donde la tabla dice «VuelaTour»; 22 gastos personales del
 * dueño, «(pendiente)» donde dice «Personal»; 25 de empresa o comisión
 * (VuelaTour) CON avión sellado salían con la matrícula aunque no se le
 * cargan; los 8 repartidos decían «Repartido (N)» sin los aviones, y los 37
 * pendientes de verdad pasan de «(pendiente)» a «Falta avión».
 *
 * Precedencia — la MISMA de la tabla (gana la primera que aplica):
 *  1. Con reparto ⇒ «Repartido: N4142R, N621TX» (cada parte con su
 *     matrícula; «¿?» si el join no la trae) y «, VuelaTour» al final si
 *     queda remanente. El remanente lo decide `expandirConReparto`, la
 *     fuente única de los libros: el Excel dice «VuelaTour» justo cuando los
 *     libros le cargan algo a la empresa.
 *  2. PERSONAL_DUENO ⇒ «Personal» (fuera de balances).
 *  2b. NÓMINA sin reparto (16-oct-2026, API 0.0.90, invariante 91) ⇒ «Sin
 *     repartir» (+ « (ref. N4142R)» con avión sellado): no entra a ningún
 *     balance hasta repartirla entre aviones en el módulo Nómina. Va ANTES
 *     de la 3 (NÓMINA sigue siendo categoría de empresa) y después de la 1
 *     (repartida dice «Repartido: …» como cualquier otra).
 *  3. Empresa (`categoriaEsDeEmpresa`), «Comisión del vendedor (VuelaTour)»
 *     (`ladoPagoVendedor` = VUELATOUR) u «Otros movimientos (VuelaTour)»
 *     (23-oct-2026, invariante 107: egreso de VuelaTour de la hoja «otros
 *     movimientos» del Balance general) ⇒ «VuelaTour» SIEMPRE, aunque traiga
 *     avión sellado (la categoría de empresa manda sobre el vuelo, regla del
 *     11-sep-2026).
 *     En 2, 2b y 3, con avión sellado: « (ref. N4142R)» — solo referencia,
 *     no se le carga.
 *  3b. PAGO DE AFAC marcado (16-oct-2026, invariante 90; `esPagoAfac`) ⇒
 *     «VuelaTour · pago de AFAC» (+ « (ref. N4142R)» con avión sellado):
 *     lo paga VuelaTour, no le resta al avión. Sin la migración la lista no
 *     trae la marca y la regla no aplica.
 *  4. Con avión ⇒ su matrícula. Un INDIRECTO con UN avión dice la matrícula
 *     (resta en el balance de ese avión), no «VuelaTour».
 *  5. Resto de `CATEGORIAS_GASTO_SIN_AVION` (hoy solo INDIRECTO sin avión)
 *     ⇒ «VuelaTour».
 *  6. Lo demás ⇒ «Falta avión»: EXACTAMENTE la bandeja `?pendientes=true`
 *     (`aeronave_id` null y categoría fuera de `CATEGORIAS_GASTO_SIN_AVION`),
 *     así el Excel cuenta lo mismo que la pestaña «Pendientes» (37 en prod).
 *
 * SOLO TEXTO: ningún número ni otra columna del Excel cambia. Lee lo que
 * `list()` ya trae (`aeronave`, `repartos` con su `aeronave`): cero lecturas
 * nuevas. El vuelo NO se agrega a la celda (el Excel no tiene la línea
 * «Vuelo #437» de la tabla). Sin matrícula en el join de un gasto con avión
 * se escribe «Avión asignado» (la etiqueta de texto del panel,
 * `etiquetaAvionGasto`): el «Ver avión» de la tabla es un enlace.
 *
 * Si la tabla del panel cambia una regla o un texto, cambia aquí en el mismo
 * lote: la prueba de paridad truena.
 */
import {
  CATEGORIA_NOMINA,
  CATEGORIA_OTROS_MOVIMIENTOS,
  CATEGORIAS_GASTO_SIN_AVION,
  categoriaEsDeEmpresa,
  ladoPagoVendedor,
} from '../../common/categoria-gasto.util';
import {
  expandirConReparto,
  type GastoRepartoFila,
} from '../../common/gasto-reparto.util';
import {
  ETIQUETA_AVION_PAGO_AFAC,
  esPagoAfac,
} from '../../common/afac-real.util';

export { ETIQUETA_AVION_PAGO_AFAC };

/** «Falta avión» (espejo de `ETIQUETA_FALTA_AVION` del panel). */
export const ETIQUETA_FALTA_AVION = 'Falta avión';
/** «VuelaTour» (espejo de `ETIQUETA_AVION_VUELATOUR` del panel). */
export const ETIQUETA_AVION_VUELATOUR = 'VuelaTour';
/** «Personal» (espejo de `ETIQUETA_AVION_PERSONAL` del panel). */
export const ETIQUETA_AVION_PERSONAL = 'Personal';
/**
 * «Sin repartir» (16-oct-2026, invariante 91): NÓMINA sin reparto. MISMO
 * texto que la tabla del panel (`estadoAvionGasto` de `lib/admin/
 * gasto-avion.ts`; lo vigila `gasto-avion.paridad.spec`).
 */
export const ETIQUETA_AVION_SIN_REPARTIR = 'Sin repartir';
/** «Repartido:» (espejo de `ETIQUETA_REPARTIDO` del panel). */
export const ETIQUETA_REPARTIDO = 'Repartido:';
/** Parte de un reparto sin matrícula en el join (`MATRICULA_DESCONOCIDA`). */
export const MATRICULA_DESCONOCIDA = '¿?';
/**
 * Gasto con avión sin matrícula en el join: la etiqueta de TEXTO del panel
 * (`etiquetaAvionGasto`); en la tabla es el enlace «Ver avión». Hoy no
 * ocurre (`aeronave.matricula` es NOT NULL y el FK garantiza el join).
 */
export const TEXTO_AVION_SIN_MATRICULA = 'Avión asignado';

/** «ref. N4142R» (espejo de `textoReferenciaAvion` del panel). */
export function textoReferenciaAvion(matricula: string): string {
  return `ref. ${matricula}`;
}

/** «¿A dónde va el dinero de este gasto?», como lo decide la tabla. */
export type EstadoAvionGasto =
  | {
      tipo: 'REPARTIDO';
      /** Una por parte, en el orden del embed (null = sin matrícula). */
      matriculas: Array<string | null>;
      /** ¿Queda remanente que absorbe VuelaTour? (`expandirConReparto`). */
      conRemanente: boolean;
    }
  | {
      tipo: 'FUERA_DEL_AVION';
      etiqueta:
        | typeof ETIQUETA_AVION_VUELATOUR
        | typeof ETIQUETA_AVION_PERSONAL
        | typeof ETIQUETA_AVION_SIN_REPARTIR
        | typeof ETIQUETA_AVION_PAGO_AFAC;
      /** Matrícula sellada que NO se carga (solo referencia) o null. */
      referencia: string | null;
    }
  | { tipo: 'AVION'; matricula: string | null }
  | { tipo: 'FALTA' };

/** Clave interna para pedirle el remanente a `expandirConReparto`. */
const GASTO = 'gasto';

function objeto(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object'
    ? (v as Record<string, unknown>)
    : null;
}

/** `aeronave.matricula` del embed (`aeronave:aeronave_id(matricula)`). */
function matriculaDe(
  conAeronave: Record<string, unknown> | null,
): string | null {
  const m = objeto(conAeronave?.aeronave)?.matricula;
  return typeof m === 'string' ? m : null;
}

/** ¿El reparto deja remanente? La regla de los libros, sin copiarla. */
function quedaRemanente(
  monto: unknown,
  partes: ReadonlyArray<Record<string, unknown> | null>,
): boolean {
  const filas: GastoRepartoFila[] = partes.map((p) => ({
    gasto_id: GASTO,
    aeronave_id: typeof p?.aeronave_id === 'string' ? p.aeronave_id : '',
    monto: Number(p?.monto),
  }));
  return (
    expandirConReparto([{ id: GASTO, monto }], new Map([[GASTO, filas]]))
      .empresa.length > 0
  );
}

/**
 * Estado de la columna para una fila de `list()` (con sus embeds de
 * siempre: `aeronave` y `repartos`). La precedencia está en el encabezado.
 */
export function estadoAvionGasto(
  fila: Record<string, unknown>,
): EstadoAvionGasto {
  const repartos = Array.isArray(fila.repartos)
    ? (fila.repartos as unknown[]).map(objeto)
    : [];
  if (repartos.length > 0) {
    return {
      tipo: 'REPARTIDO',
      matriculas: repartos.map(matriculaDe),
      conRemanente: quedaRemanente(fila.monto, repartos),
    };
  }
  const categoria = typeof fila.categoria === 'string' ? fila.categoria : null;
  const tieneAvion = !!fila.aeronave_id;
  const referencia = tieneAvion ? matriculaDe(fila) : null;
  if (categoria === 'PERSONAL_DUENO') {
    return {
      tipo: 'FUERA_DEL_AVION',
      etiqueta: ETIQUETA_AVION_PERSONAL,
      referencia,
    };
  }
  // 2b. NÓMINA sin reparto (invariante 91): no vive en ningún balance.
  if (categoria === CATEGORIA_NOMINA) {
    return {
      tipo: 'FUERA_DEL_AVION',
      etiqueta: ETIQUETA_AVION_SIN_REPARTIR,
      referencia,
    };
  }
  if (
    categoriaEsDeEmpresa(categoria) ||
    ladoPagoVendedor(categoria) === 'VUELATOUR' ||
    // «Otros movimientos (VuelaTour)» (invariante 107): el avión sellado
    // solo informa; su egreso vive en el Balance general.
    categoria === CATEGORIA_OTROS_MOVIMIENTOS
  ) {
    return {
      tipo: 'FUERA_DEL_AVION',
      etiqueta: ETIQUETA_AVION_VUELATOUR,
      referencia,
    };
  }
  // 3b. Pago de AFAC (invariante 90): lo paga VuelaTour.
  if (
    esPagoAfac({
      categoria,
      es_pago_afac: fila.es_pago_afac === true,
    })
  ) {
    return {
      tipo: 'FUERA_DEL_AVION',
      etiqueta: ETIQUETA_AVION_PAGO_AFAC,
      referencia,
    };
  }
  if (tieneAvion) return { tipo: 'AVION', matricula: referencia };
  if (categoria != null && CATEGORIAS_GASTO_SIN_AVION.includes(categoria)) {
    return {
      tipo: 'FUERA_DEL_AVION',
      etiqueta: ETIQUETA_AVION_VUELATOUR,
      referencia: null,
    };
  }
  return { tipo: 'FALTA' };
}

/**
 * Texto de la celda: «Repartido: N4142R, N621TX[, VuelaTour]»,
 * «VuelaTour (ref. N4142R)», «Personal», «Sin repartir», la matrícula o
 * «Falta avión».
 */
export function textoAvionGasto(e: EstadoAvionGasto): string {
  switch (e.tipo) {
    case 'REPARTIDO': {
      const fichas = e.matriculas.map((m) => m ?? MATRICULA_DESCONOCIDA);
      if (e.conRemanente) fichas.push(ETIQUETA_AVION_VUELATOUR);
      return `${ETIQUETA_REPARTIDO} ${fichas.join(', ')}`;
    }
    case 'FUERA_DEL_AVION':
      return e.referencia
        ? `${e.etiqueta} (${textoReferenciaAvion(e.referencia)})`
        : e.etiqueta;
    case 'AVION':
      return e.matricula ?? TEXTO_AVION_SIN_MATRICULA;
    case 'FALTA':
      return ETIQUETA_FALTA_AVION;
  }
}

/** La celda «Avión» de una fila del Excel de gastos. */
export function celdaAvionGasto(fila: Record<string, unknown>): string {
  return textoAvionGasto(estadoAvionGasto(fila));
}
