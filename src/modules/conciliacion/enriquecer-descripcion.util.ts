/**
 * CONCEPTO DEL SPEI AL RE-SUBIR EL ESTADO DE CUENTA (13-oct-2026, lote 2,
 * API 0.0.75, invariante 69). PURO: decide QUÉ fila ya importada recibe el
 * concepto del banco; el servicio solo escribe lo que aquí se planea.
 *
 * Caso real: septiembre de EJE SCOTIA se importó con la IA leyendo SOLO el
 * renglón principal de cada SPEI («SEL TRANSF. INTERBANCARIA SPEI»): 73 de
 * 98 filas quedaron sin el concepto («… BANORTE fact vip 7360») que dice QUÉ
 * factura pagó cada una. Re-subir el PDF con el prompt nuevo NO duplica (el
 * dedupe ya tolera el prefijo), pero tampoco completaba nada.
 *
 * REGLAS QUE NUNCA ADIVINAN. Solo se completan las LEYENDAS SIN CONCEPTO de
 * la lista blanca (con un prefijo genérico, «ASA CANCUN» recibiría el texto
 * de «ASA CANCUN I»), medidas con `normalizarPlano` (NUNCA `descDedupe`, que
 * quita «SEL»/«SPEI»). Por bucket (fecha|tipo|monto) y leyenda T:
 *   G = previas con texto T; L = líneas del archivo con texto T o que lo
 *   extienden (menos las que el dedupe emparejó FUERA de G); C = las de L
 *   que lo extienden; K = las iguales a T.
 * En orden: INTERCAMBIABLES (toda G virgen: cualquier asignación deja lo
 * mismo a la vista; UNICO si G y C son de uno), UNICO, MISMO_TEXTO,
 * REFERENCIA, ORDEN_ARCHIVO y FOLIO (el número de la factura del gasto
 * ligado). Si ninguna decide: GEMELOS, se reporta con sus facturas y se
 * coteja en el portal del banco. Una fila con vínculo no bancario
 * (invariante 48) jamás se toca. Nunca devuelve montos, fechas ni ligas: el
 * UPDATE es solo `descripcion` (+ `updated_by`) con CAS sobre el texto
 * leído. Idempotente: una fila ya completada deja de ser leyenda.
 *
 * CANDADO EXTRA (no adivinar dos veces): fuera de INTERCAMBIABLES y
 * REFERENCIA —que asignan las parejas del dedupe tal cual— una regla solo
 * aplica si TODA línea que completa es duplicado de una fila del grupo; una
 * línea que además se va a INSERTAR jamás presta su texto a otra fila.
 */
import {
  claveBucket,
  nivelEmpateDedupe,
  normalizarPlano,
  refDedupe,
  type LineaDedupe,
  type ParejaDedupe,
} from './auto-cruce.util';
import { tieneNotasVinculoNoBancario } from '../../common/vinculo-no-bancario.util';
import {
  facturaDeConcepto,
  mismoNumero,
  type NumeroFactura,
} from './factura-concepto.util';

/**
 * Leyendas del banco SIN concepto, en forma `normalizarPlano`. Las 6
 * primeras están en prod (EJE SCOTIA y GASTOS GNRAL de septiembre); las 3
 * últimas son las de otros bancos con el mismo problema.
 */
export const LEYENDAS_SIN_CONCEPTO: readonly string[] = [
  'SEL TRANSF INTERBANCARIA SPEI',
  'TRANSF INTERBANCARIA SPEI',
  'TRANSF ENVIO SPEI BCA INTERNET',
  'SEL PAGO DE SERVICIOS',
  '03 POR COBRANZA DOMICILIADA',
  'SCN PAGOS A PROVEEDORES',
  'CGO SPEI',
  'SPEI ENVIADO',
  'SPEI RECIBIDO',
];
const LEYENDAS = new Set(LEYENDAS_SIN_CONCEPTO);

/** Tope del rastro `enriquecimiento.detalle` en el job. */
export const ENRIQUECIMIENTO_DETALLE_MAX = 300;
/** Tope de `enriquecimiento.omitidos` en el job. */
export const ENRIQUECIMIENTO_OMITIDOS_MAX = 50;
/** Tope de `enriquecibles_detalle` / `nuevos_detalle` de la vista previa. */
export const VISTA_PREVIA_DETALLE_MAX = 50;
/** Tope de `omitidos` de la vista previa. */
export const VISTA_PREVIA_OMITIDOS_MAX = 20;
/** Tope de `nuevos_mismo_dia_y_monto_detalle`. */
export const NUEVOS_MISMO_DIA_DETALLE_MAX = 20;
/** Conceptos distintos que viajan por grupo de GEMELOS. */
export const CONCEPTOS_GEMELOS_MAX = 5;
/** Largo de cada concepto que viaja en un omitido. */
export const CONCEPTO_TEXTO_MAX = 160;
/** Largo máximo de la descripción que se guarda. */
export const DESCRIPCION_GUARDADA_MAX = 200;
/** Gemelos que la regla FOLIO intenta emparejar (búsqueda exhaustiva). */
export const FOLIO_GEMELOS_MAX = 7;

export type ReglaEnriquecimiento =
  | 'UNICO'
  | 'MISMO_TEXTO'
  | 'INTERCAMBIABLES'
  | 'REFERENCIA'
  | 'ORDEN_ARCHIVO'
  | 'FOLIO';

export type MotivoSinEnriquecer =
  | 'GEMELOS'
  | 'VINCULO_NO_BANCARIO'
  | 'CAMBIO_CONCURRENTE'
  | 'ERROR';

/** Orden de las fechas de un archivo: del más viejo al más nuevo o al revés. */
export type DireccionArchivo = 'ASC' | 'DESC';

/** Fila YA importada (lo que lee `leerPreviosDedupe`). */
export interface FilaPreviaEnriquecible extends LineaDedupe {
  id: string;
  origen?: string | null;
  conciliado?: boolean | null;
  gasto_id?: string | null;
  gastos_n?: number | null;
  cobro_id?: string | null;
  cobros_n?: number | null;
  cobro_grupo_id?: string | null;
  ingreso_id?: string | null;
  clasificacion_id?: string | null;
  reverso_de_id?: string | null;
  notas?: string | null;
  estado_cuenta_id?: string | null;
  orden_archivo?: number | null;
  created_at?: string | null;
}

/** Línea del archivo que se está subiendo (posición = `orden_archivo`). */
export interface LineaNuevaEnriquecedora extends LineaDedupe {
  orden_archivo: number;
}

/** Un concepto que se va a completar. */
export interface EnriquecimientoPlaneado {
  previo_id: string;
  fecha: string;
  tipo: string;
  monto: number;
  antes: string;
  despues: string;
  regla: ReglaEnriquecimiento;
  orden_archivo_nuevo: number;
}

/** Movimientos que se quedan SIN concepto, con el porqué. */
export interface EnriquecimientoOmitido {
  motivo: MotivoSinEnriquecer;
  fecha: string;
  tipo: string;
  monto: number;
  moneda: string | null;
  movimiento_ids: string[];
  /** Conceptos que traía el archivo (≤ 5, ≤ 160 caracteres). */
  conceptos: string[];
  /** «Factura 7352» de cada concepto (sin repetir). */
  facturas: string[];
  /** Error de BD (≤ 200) en ERROR. */
  detalle?: string;
}

/** ¿La descripción es una leyenda de la lista blanca? */
export function esLeyendaSinConcepto(d: string | null | undefined): boolean {
  return LEYENDAS.has(normalizarPlano(d));
}

/** Espacios simples, recortada y ≤ 200 caracteres; vacía ⇒ null. */
export function descripcionParaGuardar(
  d: string | null | undefined,
): string | null {
  if (typeof d !== 'string') return null;
  const t = d.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > DESCRIPCION_GUARDADA_MAX
    ? t.slice(0, DESCRIPCION_GUARDADA_MAX).trimEnd()
    : t;
}

/**
 * ¿La línea EXTIENDE la leyenda T (`normalizarPlano`)? Jamás con
 * `descDedupe`: quita «SEL» y «SPEI» y «SPEI ENVIADO…» extendería a
 * «SEL TRANSF…».
 */
export function extiendeLeyenda(
  leyenda: string,
  d: string | null | undefined,
): boolean {
  return normalizarPlano(d).startsWith(`${leyenda} `);
}

/**
 * ¿Se le puede escribir el concepto? Solo filas IMPORTADAS (una MANUAL la
 * escribió la oficina) y sin la nota de un vínculo NO bancario (invariante
 * 48: esa nota cita la leyenda del cargo).
 */
export function esPreviaElegible(p: FilaPreviaEnriquecible): boolean {
  const origen = p.origen == null ? 'IMPORTADO' : String(p.origen);
  return origen === 'IMPORTADO' && !tieneNotasVinculoNoBancario(p.notas);
}

/**
 * Fila «virgen»: elegible, sin conciliar, sin ninguna liga (gasto, partes,
 * cobro, cobros, sobre, ingreso, clasificación, reverso) y sin notas. Dos
 * vírgenes del mismo bucket son INDISTINGUIBLES: cualquier asignación deja
 * lo mismo a la vista.
 */
export function esFilaVirgen(p: FilaPreviaEnriquecible): boolean {
  return (
    esPreviaElegible(p) &&
    p.conciliado === false &&
    !p.gasto_id &&
    !(Number(p.gastos_n) > 0) &&
    !p.cobro_id &&
    !(Number(p.cobros_n) > 0) &&
    !p.cobro_grupo_id &&
    !p.ingreso_id &&
    !p.clasificacion_id &&
    !p.reverso_de_id &&
    !(p.notas ?? '').trim()
  );
}

/**
 * Dirección de un archivo por sus fechas EN ORDEN del archivo: ASC si nunca
 * bajan y la primera es menor que la última; DESC al revés; si no, null.
 */
export function direccionDeFechas(
  fechas: ReadonlyArray<string | null | undefined>,
): DireccionArchivo | null {
  const fs = fechas.filter((f): f is string => typeof f === 'string' && !!f);
  if (fs.length < 2) return null;
  let sube = true;
  let baja = true;
  for (let i = 1; i < fs.length; i++) {
    if (fs[i] < fs[i - 1]) sube = false;
    if (fs[i] > fs[i - 1]) baja = false;
  }
  if (sube && fs[0] < fs[fs.length - 1]) return 'ASC';
  if (baja && fs[0] > fs[fs.length - 1]) return 'DESC';
  return null;
}

/** Un grupo (bucket, leyenda) del plan. */
interface GrupoLeyenda {
  leyenda: string;
  /** Índices de previas con texto = leyenda. */
  G: number[];
  /** Índices de líneas con texto = leyenda o que la extienden. */
  L: number[];
  /** Las de L que la extienden. */
  C: number[];
  /** Las de L iguales a la leyenda. */
  K: number[];
  /** ¿Alguna previa de G está emparejada con una línea fuera de L? */
  afuera: boolean;
  /** Parejas del dedupe (previa ∈ G, línea ∈ C). */
  pares: ParejaDedupe[];
}

function gruposDeLeyenda(
  nuevos: readonly LineaDedupe[],
  previos: readonly LineaDedupe[],
  parejas: readonly ParejaDedupe[],
): GrupoLeyenda[] {
  const parejaDePrevio = new Map(parejas.map((p) => [p.previo, p]));
  const parejaDeNuevo = new Map(parejas.map((p) => [p.nuevo, p]));
  const buckets = new Map<string, { n: number[]; p: number[] }>();
  nuevos.forEach((n, i) => {
    const k = claveBucket(n);
    const b = buckets.get(k) ?? { n: [], p: [] };
    b.n.push(i);
    buckets.set(k, b);
  });
  previos.forEach((p, i) => buckets.get(claveBucket(p))?.p.push(i));
  const out: GrupoLeyenda[] = [];
  for (const b of buckets.values()) {
    const leyendas = [
      ...new Set(
        b.p
          .map((i) => normalizarPlano(previos[i].descripcion))
          .filter((t) => LEYENDAS.has(t)),
      ),
    ];
    for (const T of leyendas) {
      const G = b.p.filter(
        (i) => normalizarPlano(previos[i].descripcion) === T,
      );
      const Gs = new Set(G);
      const L = b.n.filter((i) => {
        const t = normalizarPlano(nuevos[i].descripcion);
        if (t !== T && !t.startsWith(`${T} `)) return false;
        const pj = parejaDeNuevo.get(i);
        return !pj || Gs.has(pj.previo);
      });
      const C = L.filter((i) => extiendeLeyenda(T, nuevos[i].descripcion));
      const Cs = new Set(C);
      const K = L.filter((i) => !Cs.has(i));
      const Ls = new Set(L);
      const afuera = G.some((pi) => {
        const pj = parejaDePrevio.get(pi);
        return !!pj && !Ls.has(pj.nuevo);
      });
      const pares = parejas.filter((p) => Gs.has(p.previo) && Cs.has(p.nuevo));
      out.push({ leyenda: T, G, L, C, K, afuera, pares });
    }
  }
  return out;
}

const ligadaAGasto = (p: FilaPreviaEnriquecible) =>
  !!p.gasto_id || Number(p.gastos_n) > 0;

/**
 * Previas cuyo FOLIO hay que leer (regla FOLIO): no vírgenes, ligadas a
 * gasto, en grupos de 2 o más previas con al menos una línea que extiende.
 */
export function idsParaLeerFolios(
  nuevos: readonly LineaNuevaEnriquecedora[],
  previos: readonly FilaPreviaEnriquecible[],
  parejas: readonly ParejaDedupe[],
): string[] {
  const ids = new Set<string>();
  for (const g of gruposDeLeyenda(nuevos, previos, parejas)) {
    if (g.G.length < 2 || g.C.length === 0) continue;
    for (const pi of g.G) {
      const p = previos[pi];
      if (!esFilaVirgen(p) && ligadaAGasto(p)) ids.add(p.id);
    }
  }
  return [...ids];
}

/**
 * Estados de cuenta cuya DIRECCIÓN hay que leer (regla ORDEN_ARCHIVO): los
 * de grupos de 2 o más previas no todas vírgenes, sin «afuera», sin líneas
 * iguales a la leyenda y con tantas líneas como previas, cuyas previas
 * tienen TODAS `orden_archivo` y el MISMO `estado_cuenta_id`.
 */
export function estadoCuentaIdsParaDireccion(
  nuevos: readonly LineaNuevaEnriquecedora[],
  previos: readonly FilaPreviaEnriquecible[],
  parejas: readonly ParejaDedupe[],
): string[] {
  const ids = new Set<string>();
  for (const g of gruposDeLeyenda(nuevos, previos, parejas)) {
    if (g.G.length < 2 || g.C.length !== g.G.length) continue;
    if (g.afuera || g.K.length > 0) continue;
    if (g.G.every((pi) => esFilaVirgen(previos[pi]))) continue;
    const eid = mismoEstadoCuenta(g.G.map((pi) => previos[pi]));
    if (eid) ids.add(eid);
  }
  return [...ids];
}

/** El `estado_cuenta_id` común si TODAS traen `orden_archivo`; si no, null. */
function mismoEstadoCuenta(
  filas: readonly FilaPreviaEnriquecible[],
): string | null {
  if (filas.length === 0) return null;
  const eid = filas[0].estado_cuenta_id ?? null;
  if (!eid) return null;
  for (const p of filas) {
    if (typeof p.orden_archivo !== 'number' || !(p.orden_archivo >= 1)) {
      return null;
    }
    if ((p.estado_cuenta_id ?? null) !== eid) return null;
  }
  return eid;
}

/**
 * Líneas que se INSERTARÍAN en un bucket (fecha|tipo|monto) que ya tenía
 * alguna fila: «misma fecha y monto» — casi siempre la MISMA línea leída de
 * otro modo (renglón reescrito, otro dígito de factura, clave de rastreo).
 */
export function lineasNuevasEnBucketConocido<T extends LineaDedupe>(
  aInsertar: readonly T[],
  previos: readonly LineaDedupe[],
): T[] {
  const conocidos = new Set(previos.map((p) => claveBucket(p)));
  return aInsertar.filter((n) => conocidos.has(claveBucket(n)));
}

/** ¿Las referencias (`refDedupe`) existen y son distintas entre sí? */
function referenciasDistintas(
  refs: ReadonlyArray<string | null | undefined>,
): boolean {
  const norm = refs.map((r) => refDedupe(r));
  if (norm.some((r) => r === null)) return false;
  return new Set(norm).size === norm.length;
}

/**
 * Cuántos emparejamientos PERFECTOS G ↔ C cumplen `permitido` (la búsqueda
 * corta en el segundo) y el primero que encontró.
 */
function emparejamientosPerfectos(
  G: readonly number[],
  C: readonly number[],
  permitido: (pi: number, ni: number) => boolean,
): { cuenta: number; ejemplo: Array<[number, number]> | null } {
  let cuenta = 0;
  let ejemplo: Array<[number, number]> | null = null;
  const usados = new Array<boolean>(C.length).fill(false);
  const asignacion: Array<[number, number]> = [];
  const rec = (i: number) => {
    if (cuenta >= 2) return;
    if (i === G.length) {
      cuenta += 1;
      ejemplo ??= [...asignacion];
      return;
    }
    for (let j = 0; j < C.length; j++) {
      if (usados[j] || !permitido(G[i], C[j])) continue;
      usados[j] = true;
      asignacion.push([G[i], C[j]]);
      rec(i + 1);
      asignacion.pop();
      usados[j] = false;
    }
  };
  rec(0);
  return { cuenta, ejemplo };
}

/** Contexto del plan (lecturas best-effort del servicio). */
export interface ContextoEnriquecimiento {
  /** previa → números de factura de su(s) gasto(s) ligado(s) (regla FOLIO). */
  foliosPorPrevia?: ReadonlyMap<string, NumeroFactura[]>;
  /** Dirección del archivo que se sube (por `orden_archivo`). */
  direccionArchivoNuevo?: DireccionArchivo | null;
  /** estado_cuenta_id → dirección del archivo con el que se importó. */
  direccionPorEstadoCuenta?: ReadonlyMap<string, DireccionArchivo | null>;
  /** Moneda de la cuenta (viaja en los omitidos). */
  moneda?: string | null;
}

/**
 * EL PLAN: qué filas ya importadas reciben el concepto del archivo y cuáles
 * se quedan sin él (y por qué). Ver el encabezado del archivo.
 */
export function planEnriquecimiento(
  nuevos: readonly LineaNuevaEnriquecedora[],
  previos: readonly FilaPreviaEnriquecible[],
  parejas: readonly ParejaDedupe[],
  ctx: ContextoEnriquecimiento = {},
): {
  enriquecer: EnriquecimientoPlaneado[];
  omitidos: EnriquecimientoOmitido[];
} {
  const enriquecer: EnriquecimientoPlaneado[] = [];
  const omitidos: EnriquecimientoOmitido[] = [];
  const moneda = ctx.moneda ?? null;
  const plano = (i: number) => normalizarPlano(nuevos[i].descripcion);
  const conceptoDe = (i: number) =>
    (descripcionParaGuardar(nuevos[i].descripcion) ?? '').slice(
      0,
      CONCEPTO_TEXTO_MAX,
    );
  const facturasDe = (idx: readonly number[]) => {
    const out: string[] = [];
    for (const i of idx) {
      const fc = facturaDeConcepto(nuevos[i].descripcion);
      if (fc && !out.includes(fc.texto)) out.push(fc.texto);
    }
    return out;
  };
  const conceptosDe = (idx: readonly number[]) => {
    const out: string[] = [];
    for (const i of idx) {
      const c = conceptoDe(i);
      if (c && !out.includes(c)) out.push(c);
    }
    return out.slice(0, CONCEPTOS_GEMELOS_MAX);
  };
  const base = (p: FilaPreviaEnriquecible) => ({
    fecha: p.fecha ?? '',
    tipo: p.tipo ?? '',
    monto: Number(p.monto) || 0,
    moneda,
  });

  for (const g of gruposDeLeyenda(nuevos, previos, parejas)) {
    const { G, L, C, K, afuera, pares } = g;
    if (C.length === 0) continue;
    // Toda línea que completa es duplicado de una fila del grupo (CANDADO
    // EXTRA del encabezado): con |C| = |G| es un emparejamiento perfecto.
    const cDuplicadas = pares.length === C.length;
    let asignacion: Array<[number, number]> | null = null;
    let regla: ReglaEnriquecimiento | null = null;

    if (G.every((pi) => esFilaVirgen(previos[pi]))) {
      asignacion = pares.map((p): [number, number] => [p.previo, p.nuevo]);
      regla = G.length === 1 && C.length === 1 ? 'UNICO' : 'INTERCAMBIABLES';
    } else if (!afuera && G.length === 1 && L.length === 1 && cDuplicadas) {
      asignacion = [[G[0], C[0]]];
      regla = 'UNICO';
    } else if (
      !afuera &&
      K.length === 0 &&
      C.length >= G.length &&
      pares.length === G.length &&
      new Set(C.map(plano)).size === 1
    ) {
      const primera = [...C].sort(
        (a, b) => nuevos[a].orden_archivo - nuevos[b].orden_archivo || a - b,
      )[0];
      asignacion = G.map((pi): [number, number] => [pi, primera]);
      regla = 'MISMO_TEXTO';
    } else if (
      !afuera &&
      pares.length > 0 &&
      pares.every((p) => p.nivel === 0) &&
      referenciasDistintas(G.map((pi) => previos[pi].referencia)) &&
      referenciasDistintas(L.map((i) => nuevos[i].referencia))
    ) {
      asignacion = pares.map((p): [number, number] => [p.previo, p.nuevo]);
      regla = 'REFERENCIA';
    } else {
      asignacion = porOrdenDeArchivo(g, nuevos, previos, ctx, cDuplicadas);
      if (asignacion) {
        regla = 'ORDEN_ARCHIVO';
      } else if (
        !afuera &&
        K.length === 0 &&
        C.length === G.length &&
        G.length <= FOLIO_GEMELOS_MAX &&
        cDuplicadas
      ) {
        const folios =
          ctx.foliosPorPrevia ?? new Map<string, NumeroFactura[]>();
        const permitido = (pi: number, ni: number) => {
          const p = previos[pi];
          if (nivelEmpateDedupe(nuevos[ni], p) === null) return false;
          if (esFilaVirgen(p)) return true;
          const delGasto = folios.get(p.id) ?? [];
          const delConcepto =
            facturaDeConcepto(nuevos[ni].descripcion)?.numeros ?? [];
          return delGasto.some((f) =>
            delConcepto.some((x) => mismoNumero(f, x)),
          );
        };
        const r = emparejamientosPerfectos(G, C, permitido);
        if (r.cuenta === 1 && r.ejemplo) {
          asignacion = r.ejemplo;
          regla = 'FOLIO';
        }
      }
    }

    if (!asignacion || !regla) {
      const p0 = previos[G[0]];
      omitidos.push({
        motivo: 'GEMELOS',
        ...base(p0),
        movimiento_ids: G.map((pi) => previos[pi].id),
        conceptos: conceptosDe(C),
        facturas: facturasDe(C),
      });
      continue;
    }

    for (const [pi, ni] of asignacion) {
      const p = previos[pi];
      if (!esPreviaElegible(p)) {
        const origen = p.origen == null ? 'IMPORTADO' : String(p.origen);
        if (origen === 'IMPORTADO') {
          omitidos.push({
            motivo: 'VINCULO_NO_BANCARIO',
            ...base(p),
            movimiento_ids: [p.id],
            conceptos: conceptosDe([ni]),
            facturas: facturasDe([ni]),
          });
        }
        continue;
      }
      if (plano(ni) === normalizarPlano(p.descripcion)) continue;
      const despues = descripcionParaGuardar(nuevos[ni].descripcion);
      if (!despues || typeof p.descripcion !== 'string') continue;
      enriquecer.push({
        previo_id: p.id,
        fecha: p.fecha ?? '',
        tipo: p.tipo ?? '',
        monto: Number(p.monto) || 0,
        antes: p.descripcion,
        despues,
        regla,
        orden_archivo_nuevo: nuevos[ni].orden_archivo,
      });
    }
  }
  enriquecer.sort(
    (a, b) =>
      a.orden_archivo_nuevo - b.orden_archivo_nuevo ||
      (a.previo_id < b.previo_id ? -1 : a.previo_id > b.previo_id ? 1 : 0),
  );
  return { enriquecer, omitidos };
}

/**
 * Regla ORDEN_ARCHIVO: gemelos de UN mismo archivo previo con dirección
 * conocida contra un archivo nuevo con dirección conocida. Se ordena C por
 * su posición y G por la suya (al revés si las direcciones difieren) y se
 * empareja por rango; cada pareja debe seguir siendo la MISMA línea para el
 * dedupe. null = no aplica.
 */
function porOrdenDeArchivo(
  g: GrupoLeyenda,
  nuevos: readonly LineaNuevaEnriquecedora[],
  previos: readonly FilaPreviaEnriquecible[],
  ctx: ContextoEnriquecimiento,
  cDuplicadas: boolean,
): Array<[number, number]> | null {
  const { G, C, K, afuera } = g;
  if (afuera || K.length > 0 || C.length !== G.length || !cDuplicadas) {
    return null;
  }
  const eid = mismoEstadoCuenta(G.map((pi) => previos[pi]));
  if (!eid) return null;
  const dirPrevio = ctx.direccionPorEstadoCuenta?.get(eid) ?? null;
  const dirNuevo = ctx.direccionArchivoNuevo ?? null;
  if (!dirPrevio || !dirNuevo) return null;
  const cOrden = [...C].sort(
    (a, b) => nuevos[a].orden_archivo - nuevos[b].orden_archivo || a - b,
  );
  const signo = dirPrevio === dirNuevo ? 1 : -1;
  const gOrden = [...G].sort(
    (a, b) =>
      signo *
        ((previos[a].orden_archivo ?? 0) - (previos[b].orden_archivo ?? 0)) ||
      a - b,
  );
  const asignacion: Array<[number, number]> = gOrden.map((pi, r) => [
    pi,
    cOrden[r],
  ]);
  for (const [pi, ni] of asignacion) {
    if (nivelEmpateDedupe(nuevos[ni], previos[pi]) === null) return null;
  }
  return asignacion;
}
