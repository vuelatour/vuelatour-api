/**
 * REVERSOS: un CARGO que el banco DEVOLVIÓ y su ABONO de devolución
 * (30-sep-2026). PURO: sin BD, sin reloj, sin red — el servicio trae los
 * movimientos y aplica la decisión; este archivo se prueba con las leyendas
 * REALES de prod.
 *
 * Pregunta del cliente (captura de Conciliación · GASTOS GNRAL): «¿Cómo
 * puedo conciliar los cargos reembolsados?». El 21-sep el banco cobró 8
 * veces «ASUR CANCUN» $825.13 (1 era real y ya tenía su gasto) y el 23-sep
 * devolvió 7 con «CARGO INDEBIDO 21 SEP 355xx». Un cargo devuelto y su
 * devolución se ANULAN: no son gasto ni ingreso. Hasta hoy la única salida
 * era clasificar a mano cada uno de los 14 movimientos.
 *
 * Modelo: el ABONO apunta al CARGO que devuelve
 * (`movimiento_bancario.reverso_de_id`, único: un cargo se devuelve UNA
 * vez) y los dos quedan conciliados con la clasificación canónica «Reverso
 * de un cargo». El trigger `tg_mov_bancario_reverso` (migración
 * 20260930000001) es el candado de verdad; `motivoParInvalido` es su ESPEJO
 * para responder un 409 legible antes de escribir.
 *
 * El emparejado automático SOLO liga lo inequívoco (principio del
 * auto-cruce): misma cuenta, mismo monto (±0.005), cargo PENDIENTE y libre
 * dentro de los 60 días previos a la devolución; si la leyenda trae la fecha
 * del cargo («21 SEP») manda esa fecha; varios cargos del MISMO día son
 * intercambiables (se toma el más antiguo); varios en fechas DISTINTAS sin
 * pista ⇒ AMBIGUO y se queda pendiente para el humano.
 */
import { normalizarPlano } from './auto-cruce.util';
import { patronReverso } from './abono-cruce.util';

/**
 * Leyendas con las que el banco DEVUELVE un cargo. Se buscan como inicio de
 * palabra sobre el texto normalizado (sin acentos, mayúsculas, sin signos):
 * «DEVOLUCIÓN» y «DEVOLUCIONES» entran; «REV ASUR MERIDA» entra por el
 * prefijo del banco que ya detecta `patronReverso`.
 */
export const PATRONES_DEVOLUCION = [
  'CARGO INDEBIDO',
  'DEVOLUCION',
  'REVERSO',
  'CONTRACARGO',
  'ABONO POR ACLARACION',
  'RECLAMACION',
] as const;

/** Días hacia ATRÁS desde la devolución en los que se busca el cargo. */
export const REVERSO_VENTANA_DIAS = 60;

/** Tolerancia de monto (la misma del trigger): igualdad a centavos. */
export const REVERSO_TOLERANCIA = 0.005;

/**
 * Holgura (±días) alrededor de la fecha que dice la leyenda cuando no hay un
 * cargo pendiente EXACTAMENTE de ese día: la fecha de operación y la de
 * aplicación del banco pueden diferir un par de días.
 */
export const REVERSO_PISTA_HOLGURA_DIAS = 3;

/**
 * ¿La descripción es la de una DEVOLUCIÓN de cargo? Devuelve el patrón que
 * empató («CARGO INDEBIDO», «DEVOLUCION», …, «REV») o null.
 */
export function patronDevolucion(
  descripcion: string | null | undefined,
): string | null {
  const t = normalizarPlano(descripcion);
  if (!t) return null;
  const conBordes = ` ${t} `;
  for (const p of PATRONES_DEVOLUCION) {
    if (conBordes.includes(` ${p}`)) return p;
  }
  return patronReverso(descripcion);
}

export function esDevolucionDeCargo(
  descripcion: string | null | undefined,
): boolean {
  return patronDevolucion(descripcion) !== null;
}

const MESES: ReadonlyArray<[string, number]> = [
  // Largos antes que cortos: la alternancia del regex toma el primero.
  ['SEPTIEMBRE', 9],
  ['SETIEMBRE', 9],
  ['NOVIEMBRE', 11],
  ['DICIEMBRE', 12],
  ['FEBRERO', 2],
  ['OCTUBRE', 10],
  ['AGOSTO', 8],
  ['ENERO', 1],
  ['MARZO', 3],
  ['ABRIL', 4],
  ['JUNIO', 6],
  ['JULIO', 7],
  ['MAYO', 5],
  ['SEPT', 9],
  ['ENE', 1],
  ['FEB', 2],
  ['MAR', 3],
  ['ABR', 4],
  ['MAY', 5],
  ['JUN', 6],
  ['JUL', 7],
  ['AGO', 8],
  ['SEP', 9],
  ['OCT', 10],
  ['NOV', 11],
  ['DIC', 12],
];
const MES_POR_NOMBRE = new Map(MESES);
const RE_DIA_MES = new RegExp(
  `(?:^|\\s)(\\d{1,2})\\s?(${MESES.map(([m]) => m).join('|')})(?=\\s|$)`,
);

function diasDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function dosDigitos(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Fecha del cargo que NOMBRA la leyenda de la devolución («CARGO INDEBIDO
 * 21 SEP 35552» ⇒ 21 de septiembre). El año sale de la fecha del abono: la
 * última fecha con ese día y mes que NO sea posterior a la devolución (un
 * «28 DIC» devuelto el 5-ene es del año anterior). Día inexistente (31 SEP)
 * o sin «DD MES» ⇒ null.
 */
export function pistaFechaDevolucion(
  descripcion: string | null | undefined,
  fechaAbono: string,
): string | null {
  const t = normalizarPlano(descripcion);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(fechaAbono)) return null;
  const m = RE_DIA_MES.exec(t);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = MES_POR_NOMBRE.get(m[2]);
  if (!mes || dia < 1) return null;
  let anio = Number(fechaAbono.slice(0, 4));
  const armar = (a: number): string | null =>
    dia <= diasDelMes(a, mes)
      ? `${a}-${dosDigitos(mes)}-${dosDigitos(dia)}`
      : null;
  let fecha = armar(anio);
  if (fecha && fecha <= fechaAbono) return fecha;
  if (!fecha && !(mes === 2 && dia === 29)) return null;
  anio -= 1;
  fecha = armar(anio);
  // 29-feb que no existe ni en el año anterior ⇒ sin pista.
  return fecha;
}

/** Días de `a` a `b` (b − a) entre dos DATE `YYYY-MM-DD`. */
function difDiasFecha(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

/** `YYYY-MM-DD` ± días. */
export function sumarDiasFecha(fecha: string, dias: number): string {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Ventana del CARGO de una devolución: [fecha − 60 días, fecha]. */
export function ventanaCargoDeAbono(fechaAbono: string): {
  desde: string;
  hasta: string;
} {
  return {
    desde: sumarDiasFecha(fechaAbono, -REVERSO_VENTANA_DIAS),
    hasta: fechaAbono,
  };
}

/** Ventana de la DEVOLUCIÓN de un cargo: [fecha, fecha + 60 días]. */
export function ventanaAbonoDeCargo(fechaCargo: string): {
  desde: string;
  hasta: string;
} {
  return {
    desde: fechaCargo,
    hasta: sumarDiasFecha(fechaCargo, REVERSO_VENTANA_DIAS),
  };
}

/** ¿Mismo monto? (±0.005, el del trigger). */
export function mismoMontoReverso(a: unknown, b: unknown): boolean {
  const x = Math.abs(Number(a) || 0);
  const y = Math.abs(Number(b) || 0);
  return Math.abs(x - y) <= REVERSO_TOLERANCIA + 1e-9;
}

/** Movimiento del banco visto por el emparejado (solo lo que decide). */
export interface MovimientoReverso {
  id: string;
  cuenta_bancaria_id: string;
  /** DATE `YYYY-MM-DD`. */
  fecha: string;
  monto: number;
  descripcion?: string | null;
  referencia?: string | null;
  /** Desempate estable entre cargos idénticos (orden de inserción). */
  created_at?: string | null;
}

/** El más antiguo primero: fecha, luego inserción, luego id (estable). */
export function compararAntiguedad(
  a: MovimientoReverso,
  b: MovimientoReverso,
): number {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Cargos que PUEDEN ser los que devolvió este abono: misma cuenta, mismo
 * monto y fecha dentro de [abono − 60 días, abono]. El llamador ya pasó
 * solo cargos PENDIENTES y libres (sin gasto/cobro/ingreso/clasificación ni
 * otra devolución).
 */
export function cargosCandidatosDeAbono<T extends MovimientoReverso>(
  abono: MovimientoReverso,
  cargos: ReadonlyArray<T>,
): T[] {
  const { desde, hasta } = ventanaCargoDeAbono(abono.fecha);
  return cargos.filter(
    (c) =>
      c.id !== abono.id &&
      c.cuenta_bancaria_id === abono.cuenta_bancaria_id &&
      mismoMontoReverso(c.monto, abono.monto) &&
      c.fecha >= desde &&
      c.fecha <= hasta,
  );
}

/**
 * Abonos que PUEDEN ser la devolución de este cargo (diálogo «Lo devolvió
 * el banco»): misma cuenta, mismo monto, fecha en [cargo, cargo + 60 días].
 * Orden: primero los que traen leyenda de devolución, luego por fecha (el
 * más cercano al cargo primero).
 */
export function abonosCandidatosDeCargo<T extends MovimientoReverso>(
  cargo: MovimientoReverso,
  abonos: ReadonlyArray<T>,
): T[] {
  const { desde, hasta } = ventanaAbonoDeCargo(cargo.fecha);
  return abonos
    .filter(
      (a) =>
        a.id !== cargo.id &&
        a.cuenta_bancaria_id === cargo.cuenta_bancaria_id &&
        mismoMontoReverso(a.monto, cargo.monto) &&
        a.fecha >= desde &&
        a.fecha <= hasta,
    )
    .sort((a, b) => {
      const da = esDevolucionDeCargo(a.descripcion) ? 0 : 1;
      const db = esDevolucionDeCargo(b.descripcion) ? 0 : 1;
      if (da !== db) return da - db;
      return compararAntiguedad(a, b);
    });
}

export type ResultadoReverso =
  | 'EMPAREJADO'
  | 'SIN_CANDIDATO'
  | 'AMBIGUO'
  | 'ERROR';

export interface DecisionReverso {
  abono_id: string;
  cargo_id: string | null;
  resultado: ResultadoReverso;
  motivo: string;
  /** Fecha del cargo que nombra la leyenda (null si no trae). */
  pista_fecha: string | null;
  /** Cargos que cuadraban en cuenta, monto y ventana. */
  candidatos_n: number;
}

/** `YYYY-MM-DD` ⇒ `DD-MM` (notas y etiquetas: la ventana es < 1 año). */
export function fechaCortaReverso(fecha: string | null | undefined): string {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(fecha)) {
    return String(fecha ?? '');
  }
  return `${fecha.slice(8, 10)}-${fecha.slice(5, 7)}`;
}

function montoTexto(monto: number): string {
  return `$${(Math.abs(Number(monto)) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * LA decisión de UN abono de devolución contra los cargos LIBRES:
 *  1) candidatos = misma cuenta, mismo monto, 60 días previos;
 *  2) con fecha en la leyenda: los de ESE día; si no hay, los de ±3 días;
 *     si tampoco, SIN_CANDIDATO (nunca se toma otra fecha «por si acaso»);
 *  3) todos del MISMO día ⇒ son intercambiables: el más antiguo;
 *     de días DISTINTOS ⇒ AMBIGUO (lo decide el humano).
 *
 * `cargosLigados` (revisión adversaria 30-sep-2026): cargos de la misma
 * cuenta y monto que la oficina YA explicó con DINERO (gasto, cobro, sobre o
 * ingreso). Nunca se emparejan, pero SÍ frenan: si el cargo que nombra la
 * leyenda —o, sin pista, el más reciente antes de la devolución— es uno
 * ligado, lo más probable es que el banco devolvió ESE (y la liga a gasto
 * está mal) ⇒ no se toma otro cargo más viejo «porque cuadra el monto».
 * Caso REAL de prod: «REV.ASUR MERIDA» del 07-08 ($110.82) con su cargo del
 * 07-08 ligado a un gasto y dos «ASUR Merida» pendientes del 06-07: sin este
 * freno se emparejaba con uno del 06-07, un mes antes.
 */
export function elegirCargoReverso(
  abono: MovimientoReverso,
  cargosLibres: ReadonlyArray<MovimientoReverso>,
  cargosLigados: ReadonlyArray<MovimientoReverso> = [],
): DecisionReverso {
  const candidatos = cargosCandidatosDeAbono(abono, cargosLibres);
  const libresIds = new Set(candidatos.map((c) => c.id));
  const ligados = cargosCandidatosDeAbono(abono, cargosLigados).filter(
    (c) => !libresIds.has(c.id),
  );
  const pista = pistaFechaDevolucion(abono.descripcion, abono.fecha);
  const base = {
    abono_id: abono.id,
    pista_fecha: pista,
    candidatos_n: candidatos.length,
  };
  const monto = montoTexto(abono.monto);
  if (candidatos.length === 0 && pista) {
    return {
      ...base,
      cargo_id: null,
      resultado: 'SIN_CANDIDATO',
      motivo: `El banco indica un cargo del ${fechaCortaReverso(pista)} y no hay uno pendiente por ${monto} en esa fecha.`,
    };
  }
  if (candidatos.length === 0) {
    return {
      ...base,
      cargo_id: null,
      resultado: 'SIN_CANDIDATO',
      motivo: `No hay cargos pendientes por ${monto} en los ${REVERSO_VENTANA_DIAS} días previos a la devolución.`,
    };
  }
  let pool = candidatos;
  if (pista) {
    const exactos = candidatos.filter((c) => c.fecha === pista);
    if (exactos.length > 0) {
      pool = exactos;
    } else {
      if (ligados.some((c) => c.fecha === pista)) {
        // El cargo que nombra el banco existe pero ya está explicado con
        // dinero: se deja al humano (no se toma uno de ±3 días).
        return {
          ...base,
          cargo_id: null,
          resultado: 'SIN_CANDIDATO',
          motivo: `El banco indica un cargo del ${fechaCortaReverso(pista)} por ${monto} y ese cargo ya está conciliado con un gasto o cobro: revísalo a mano.`,
        };
      }
      const cerca = candidatos.filter(
        (c) =>
          Math.abs(difDiasFecha(c.fecha, pista)) <= REVERSO_PISTA_HOLGURA_DIAS,
      );
      if (cerca.length === 0) {
        return {
          ...base,
          cargo_id: null,
          resultado: 'SIN_CANDIDATO',
          motivo: `El banco indica un cargo del ${fechaCortaReverso(pista)} y no hay uno pendiente por ${monto} en esa fecha.`,
        };
      }
      const distMin = Math.min(
        ...cerca.map((c) => Math.abs(difDiasFecha(c.fecha, pista))),
      );
      const ligadoMasCerca = ligados.find(
        (c) => Math.abs(difDiasFecha(c.fecha, pista)) < distMin,
      );
      if (ligadoMasCerca) {
        return {
          ...base,
          cargo_id: null,
          resultado: 'AMBIGUO',
          motivo: `El cargo por ${monto} más cercano al ${fechaCortaReverso(pista)} (el del ${fechaCortaReverso(ligadoMasCerca.fecha)}) ya está conciliado con un gasto o cobro: elige a mano cuál devolvió el banco.`,
        };
      }
      pool = cerca;
    }
  } else {
    // Sin pista: el cargo devuelto suele ser el MÁS RECIENTE antes de la
    // devolución. Si ese es uno ligado, no se adivina con uno más viejo.
    const ultimaLibre = candidatos.reduce(
      (max, c) => (c.fecha > max ? c.fecha : max),
      '',
    );
    const ligadoPosterior = ligados
      .filter((c) => c.fecha > ultimaLibre)
      .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0))[0];
    if (ligadoPosterior) {
      return {
        ...base,
        cargo_id: null,
        resultado: 'AMBIGUO',
        motivo: `El cargo por ${monto} más reciente (${fechaCortaReverso(ligadoPosterior.fecha)}) ya está conciliado con un gasto o cobro y los pendientes son de otra fecha (${fechaCortaReverso(ultimaLibre)}): elige a mano cuál devolvió el banco.`,
      };
    }
  }
  const fechas = [...new Set(pool.map((c) => c.fecha))].sort();
  if (fechas.length > 1) {
    return {
      ...base,
      cargo_id: null,
      resultado: 'AMBIGUO',
      motivo: `${pool.length} cargos pendientes por ${monto} en fechas distintas (${fechas.map(fechaCortaReverso).join(', ')}): elige a mano cuál devolvió el banco.`,
    };
  }
  const elegido = [...pool].sort(compararAntiguedad)[0];
  const porque = pista
    ? 'fecha indicada por el banco'
    : pool.length > 1
      ? 'cargos idénticos: el más antiguo'
      : 'único cargo pendiente con ese monto';
  return {
    ...base,
    cargo_id: elegido.id,
    resultado: 'EMPAREJADO',
    motivo: `Devuelve el cargo del ${fechaCortaReverso(elegido.fecha)} (${porque}).`,
  };
}

/**
 * Emparejado de un LOTE de devoluciones contra los cargos libres. Cada
 * cargo se usa UNA vez. Primero las devoluciones que traen fecha en la
 * leyenda (son las que saben cuál es su cargo), luego las demás; y se
 * repite mientras alguna se empareje, porque al consumirse un cargo otra
 * devolución que era AMBIGUA puede quedarse con un solo candidato.
 * Los abonos que NO son devolución se ignoran (no salen en el resultado).
 */
export function emparejarReversos(
  abonos: ReadonlyArray<MovimientoReverso>,
  cargos: ReadonlyArray<MovimientoReverso>,
  /** Cargos ya explicados con dinero (ver `elegirCargoReverso`). */
  cargosLigados: ReadonlyArray<MovimientoReverso> = [],
): DecisionReverso[] {
  const devoluciones = abonos
    .filter((a) => esDevolucionDeCargo(a.descripcion))
    .map((a) => ({
      a,
      pista: pistaFechaDevolucion(a.descripcion, a.fecha) !== null,
    }))
    .sort((x, y) => {
      if (x.pista !== y.pista) return x.pista ? -1 : 1;
      return compararAntiguedad(x.a, y.a);
    })
    .map((x) => x.a);
  const usados = new Set<string>();
  const decisiones = new Map<string, DecisionReverso>();
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const a of devoluciones) {
      if (decisiones.get(a.id)?.resultado === 'EMPAREJADO') continue;
      const libres = cargos.filter((c) => !usados.has(c.id));
      const d = elegirCargoReverso(a, libres, cargosLigados);
      decisiones.set(a.id, d);
      if (d.resultado === 'EMPAREJADO' && d.cargo_id) {
        usados.add(d.cargo_id);
        cambio = true;
      }
    }
  }
  return devoluciones.map((a) => decisiones.get(a.id)!);
}

/** Fila del banco con lo que deciden los candados del par. */
export interface MovimientoParReverso {
  id: string;
  tipo: string;
  cuenta_bancaria_id: string;
  monto: number | string;
  conciliado?: boolean | null;
  /** ESPEJO: el gasto cuando el cargo paga UNO (null con 0 o ≥ 2). */
  gasto_id?: string | null;
  /**
   * Partes en la puente `movimiento_bancario_gasto` (2-oct-2026, migración
   * 20261002000002; ausente sin ella). «Ligado a gasto» = `gasto_id` puesto
   * O `gastos_n > 0`: un cargo que paga 3 gastos tiene `gasto_id` null.
   */
  gastos_n?: number | string | null;
  cobro_id?: string | null;
  cobro_grupo_id?: string | null;
  ingreso_id?: string | null;
  clasificacion_id?: string | null;
  reverso_de_id?: string | null;
}

/** Lo único que miran `gastosLigadosN` / `ligadoAGasto` de una fila. */
export interface LigaGastoDeFila {
  gasto_id?: unknown;
  gastos_n?: unknown;
}

/** Partes que el movimiento tiene en la puente (0 sin la columna). */
export function gastosLigadosN(m: LigaGastoDeFila): number {
  const n = Math.trunc(Number(m.gastos_n) || 0);
  return n > 0 ? n : 0;
}

/**
 * ¿Ligado a gasto(s)? FUENTE ÚNICA de «ligado a gasto» del par:
 * `gasto_id is not null or gastos_n > 0` (el mismo predicado que el
 * trigger `tg_mov_bancario_reverso` desde la migración 20261002000002).
 */
export function ligadoAGasto(m: LigaGastoDeFila): boolean {
  return !!m.gasto_id || gastosLigadosN(m) > 0;
}

/**
 * ¿Se puede emparejar? PENDIENTE y sin ninguna liga (gasto, cobro, sobre,
 * ingreso, clasificación ni otra devolución). Un cargo ligado a un gasto
 * JAMÁS entra: el emparejado solo toma lo que nadie explicó.
 */
export function movimientoLibreParaReverso(m: MovimientoParReverso): boolean {
  return (
    m.conciliado !== true &&
    !ligadoAGasto(m) &&
    !m.cobro_id &&
    !m.cobro_grupo_id &&
    !m.ingreso_id &&
    !m.clasificacion_id &&
    !m.reverso_de_id
  );
}

/**
 * ¿Cargo que la oficina YA explicó con DINERO (gasto, cobro, sobre o
 * ingreso)? No se empareja jamás, pero frena al automático (ver
 * `elegirCargoReverso`). Una clasificación o un reverso NO cuentan: no
 * dicen que el cargo haya sido real.
 */
export function cargoLigadoConDinero(m: MovimientoParReverso): boolean {
  return (
    m.tipo === 'CARGO' &&
    !m.reverso_de_id &&
    (ligadoAGasto(m) || !!(m.cobro_id || m.cobro_grupo_id || m.ingreso_id))
  );
}

/**
 * Motivo legible de un rechazo de la BD al escribir el par: el trigger
 * lanza 23514 «REVERSO_INVALIDO: <motivo>» y el índice único
 * `uq_mov_bancario_reverso_de` un 23505 cuando otro abono ganó la carrera.
 * Cualquier otro error ⇒ null (no es de esta regla).
 */
export function motivoTriggerReverso(
  err: { code?: string | null; message?: string | null } | null | undefined,
): string | null {
  if (!err) return null;
  const msg = err.message ?? '';
  const i = msg.indexOf('REVERSO_INVALIDO');
  if (i >= 0) {
    const resto = msg
      .slice(i + 'REVERSO_INVALIDO'.length)
      .replace(/^\s*:\s*/, '')
      .trim();
    return resto || 'La base de datos rechazó el emparejado.';
  }
  if (
    (err.code === '23505' || msg.includes('23505')) &&
    msg.includes('uq_mov_bancario_reverso_de')
  ) {
    return 'Ese cargo ya tiene su devolución emparejada.';
  }
  return null;
}

function ligaDe(m: MovimientoParReverso): string | null {
  const n = gastosLigadosN(m);
  if (n >= 2) return `${n} gastos`;
  if (ligadoAGasto(m)) return 'un gasto';
  if (m.cobro_id) return 'un cobro de vuelo';
  if (m.cobro_grupo_id) return 'el sobre de un grupo';
  if (m.ingreso_id) return 'un ingreso';
  if (m.clasificacion_id || m.conciliado === true) return 'una clasificación';
  return null;
}

/**
 * ESPEJO del trigger `tg_mov_bancario_reverso` (+ lo que exige el servicio:
 * los dos PENDIENTES) para responder un 409 legible ANTES de escribir.
 * `cargoYaDevueltoPor` = id del abono que ya devuelve ese cargo (si hay).
 * Devuelve el motivo en español o null si el par es válido.
 */
export function motivoParInvalido(
  abono: MovimientoParReverso,
  cargo: MovimientoParReverso,
  cargoYaDevueltoPor: string | null = null,
): string | null {
  if (abono.tipo !== 'ABONO' || cargo.tipo !== 'CARGO') {
    return 'Se empareja un CARGO con el ABONO que lo devuelve.';
  }
  if (abono.cuenta_bancaria_id !== cargo.cuenta_bancaria_id) {
    return 'El cargo y su devolución deben ser de la misma cuenta bancaria.';
  }
  if (!mismoMontoReverso(abono.monto, cargo.monto)) {
    return `Los montos no coinciden (cargo ${montoTexto(Number(cargo.monto))}, devolución ${montoTexto(Number(abono.monto))}).`;
  }
  if (abono.reverso_de_id) {
    return 'Ese abono ya es la devolución de otro cargo.';
  }
  const ligaAbono = ligaDe(abono);
  if (ligaAbono) {
    return `El abono ya está conciliado con ${ligaAbono}: quítalo antes.`;
  }
  if (cargo.reverso_de_id) {
    return 'Ese movimiento no es un cargo que se pueda devolver.';
  }
  if (cargoYaDevueltoPor && cargoYaDevueltoPor !== abono.id) {
    return 'Ese cargo ya tiene su devolución emparejada.';
  }
  const ligaCargo = ligaDe(cargo);
  if (ligaCargo) {
    return `El cargo ya está conciliado con ${ligaCargo}: quítalo antes.`;
  }
  return null;
}

/** Texto del banco en una sola línea (las notas son por renglón). */
function unaLinea(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Nota del ABONO: «Devuelve el cargo del 21-09 · ASUR CANCUN». */
export function notaAbonoReverso(cargo: {
  fecha: string;
  descripcion?: string | null;
}): string {
  const d = unaLinea(cargo.descripcion);
  return `Devuelve el cargo del ${fechaCortaReverso(cargo.fecha)}${d ? ` · ${d}` : ''}`;
}

/** Nota del CARGO: «Devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552». */
export function notaCargoReverso(abono: {
  fecha: string;
  descripcion?: string | null;
}): string {
  const d = unaLinea(abono.descripcion);
  return `Devuelto el ${fechaCortaReverso(abono.fecha)}${d ? ` · ${d}` : ''}`;
}

const RE_LINEA_REVERSO =
  /^(Devuelve el cargo del|Devuelto el) \d{2}-\d{2}(?: · .*)?$/;

/**
 * Quita de las notas los renglones que escribió el emparejado (al
 * desemparejar, o para no duplicarlos al volver a emparejar). Lo que
 * escribió la oficina queda intacto. Vacío ⇒ null.
 */
export function quitarNotaReverso(
  notas: string | null | undefined,
): string | null {
  if (typeof notas !== 'string') return null;
  const resto = notas
    .split(/\r?\n/)
    .filter((l) => !RE_LINEA_REVERSO.test(l.trim()));
  const texto = resto.join('\n').trim();
  return texto ? texto : null;
}

/**
 * Antepone el renglón del emparejado SIN pisar lo que ya había (se quita
 * antes cualquier renglón de un emparejado anterior).
 */
export function anteponerNotaReverso(
  notas: string | null | undefined,
  linea: string,
): string {
  const previas = quitarNotaReverso(notas);
  return previas ? `${linea}\n${previas}` : linea;
}

/**
 * «Conciliado con» del reporte para un movimiento del par:
 * ABONO ⇒ «Reverso de un cargo · devuelve el cargo del 21-09 · ASUR CANCUN»;
 * CARGO ⇒ «Reverso de un cargo · devuelto el 23-09 · CARGO INDEBIDO …».
 */
export function etiquetaConciliadoReverso(
  rol: 'ABONO' | 'CARGO',
  otro: { fecha: string; descripcion?: string | null },
  clasificacion = 'Reverso de un cargo',
): string {
  const d = unaLinea(otro.descripcion);
  const cuando =
    rol === 'ABONO'
      ? `devuelve el cargo del ${fechaCortaReverso(otro.fecha)}`
      : `devuelto el ${fechaCortaReverso(otro.fecha)}`;
  return [clasificacion, cuando, d || null].filter(Boolean).join(' · ');
}
