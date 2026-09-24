/**
 * FACTURAS EMITIDAS (registro manual, 24-sep-2026) — LÓGICA PURA.
 *
 * Pedido de Ale: «que haya una de facturas emitidas para las que hace Mari
 * manualmente … y estén por orden del número de la factura … saber que esas
 * facturas ya están emitidas, que no hay unas duplicadas». Todo lo que decide
 * algo (duplicados, orden, alertas, huecos de numeración, emisor, avisos)
 * vive AQUÍ, sin Nest ni Supabase, con spec: el 409 del guardado y el banner
 * rojo «Ya está registrada» del diálogo usan la MISMA función
 * (`buscarYaRegistrada`) y nunca discrepan.
 *
 * Reglas del contrato que se congelan aquí:
 *  - Número de factura = razón social emisora + serie + folio. Duplicado =
 *    misma `claveCompacta(serie, folio)` y `mismaEmisora` (NULL = comodín).
 *  - Orden por número: `serieEfectiva` → `folio_num` → folio → alta.
 *  - Huecos por (emisora, serie) contando las CANCELADAS (ocupan número),
 *    aritméticos (jamás se enumera un rango enorme).
 *  - `DUPLICADO_VUELO` solo si ≥ 2 VIGENTES y al menos una NO es parcial.
 */
import { estadoCobroSemaforo } from '../../common/semaforo-cobro.util';
import { totalMxnDeVuelo } from '../../common/tc.util';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import { etiquetaSerieFolio } from '../flights/factura-cliente.util';
import type {
  AlertaFactura,
  AvisoFactura,
  CobroResumen,
  EstatusFacturaEmitida,
  FacturaExistente,
  FiltroAlerta,
  HuecoSerie,
  MonedaFactura,
  OrdenFacturas,
  TotalMoneda,
  TotalVuelo,
} from './facturas-emitidas.types';

/** Ids por consulta `.in(...)`: la URL de PostgREST no crece sin tope. */
export const LOTE_IDS = 200;
/** Filas por página al leer TODO el registro (anti-cap de PostgREST). */
export const PAGINA_BD = 1000;
/** Etiquetas de folios faltantes que se listan por serie. */
export const MAX_FALTANTES_LISTADOS = 20;

/** MISMA regex que el CHECK `factura_emitida_rfc_chk`. */
export const RE_RFC = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
/** MISMA regex que el CHECK `factura_emitida_uuid_chk` (MAYÚSCULAS). */
export const RE_UUID_FISCAL =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** Columnas de `factura_emitida` que lee el API (sin `deleted_*`). */
export const COLS_FACTURA_EMITIDA =
  'id, serie, folio, folio_num, uuid, fecha_emision, estatus, emisor_rfc, emisor_nombre, emisora_id, receptor_rfc, receptor_nombre, cliente_id, moneda, subtotal, iva, total, metodo_pago, forma_pago, notas, es_parcial, archivos_historial, pdf_path, pdf_nombre, pdf_subido_at, pdf_subido_por, xml_path, xml_nombre, xml_subido_at, xml_subido_por, cancelada_at, cancelada_por, motivo_cancelacion, created_at, created_by, updated_at, updated_by';

/** Columnas del vuelo que viajan con cada liga del puente. */
export const COLS_VUELO_LIGADO =
  'id, folio, fecha_vuelo, estado, cliente_id, monto_total_usd, monto_total_mxn, tc_usd_mxn, cobrado, cotizacion_abierta, es_externo, grupo_id';

/** Fila cruda de `factura_emitida` (PostgREST: `numeric` llega como string). */
export interface FacturaEmitidaRow {
  id: string;
  serie: string | null;
  folio: string;
  folio_num: unknown;
  uuid: string | null;
  fecha_emision: string;
  estatus: string;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
  emisora_id: string | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  cliente_id: string | null;
  moneda: string;
  subtotal: unknown;
  iva: unknown;
  total: unknown;
  metodo_pago: string | null;
  forma_pago: string | null;
  notas: string | null;
  es_parcial: boolean | null;
  archivos_historial: unknown;
  pdf_path: string | null;
  pdf_nombre: string | null;
  pdf_subido_at: string | null;
  pdf_subido_por: string | null;
  xml_path: string | null;
  xml_nombre: string | null;
  xml_subido_at: string | null;
  xml_subido_por?: string | null;
  cancelada_at: string | null;
  cancelada_por: string | null;
  motivo_cancelacion: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by?: string | null;
  deleted_at?: string | null;
}

/** Vuelo embebido en una liga del puente (COLS_VUELO_LIGADO). */
export interface VueloLigadoRow {
  id: string;
  folio: number | string;
  fecha_vuelo: string | null;
  estado: string;
  cliente_id: string | null;
  monto_total_usd: unknown;
  monto_total_mxn: unknown;
  tc_usd_mxn: unknown;
  cobrado: boolean | null;
  cotizacion_abierta: boolean | null;
  es_externo: boolean | null;
  grupo_id: string | null;
}

export interface LigaFacturaVuelo {
  factura_id: string;
  vuelo_id: string;
  vuelo: VueloLigadoRow | null;
}

// ============================ NÚMEROS Y TEXTO ============================

/** `numeric` de PostgREST (string) → number; vacío/basura → null. */
export function numeroONull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Redondeo a centavos (dinero de la factura). */
export function redondear2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Espejo de la columna GENERADA `folio_num`:
 * `nullif(regexp_replace(folio, '[^0-9]', '', 'g'), '')::numeric`.
 * 'A-00123' ⇒ 123 · 'Z' ⇒ null.
 */
export function folioNumDe(folio: string | null | undefined): number | null {
  const digitos = (folio ?? '').replace(/[^0-9]/g, '');
  if (!digitos) return null;
  const n = Number(digitos);
  return Number.isFinite(n) ? n : null;
}

/** Quita acentos SIN perder la Ñ (MAYÚSCULAS). */
function sinAcentosMayus(s: string): string {
  return s
    .toUpperCase()
    .replace(/Ñ/g, '\uE000')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\uE000/g, 'Ñ');
}

/** Búsqueda libre: sin acentos + minúsculas (el `q` de la lista). */
export function normalizarBusqueda(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * CLAVE COMPACTA del número de una factura: serie + folio en MAYÚSCULAS, sin
 * acentos, sin NADA que no sea `[A-Z0-9Ñ]` y sin ceros a la izquierda de cada
 * tramo de dígitos. «A» + «00123», «A-123» sin serie, «a 123» y «A / 123» ⇒
 * `A123`. La usan el 409, `ya_registrada` y la comparación contra el XML: así
 * un XML que separa serie y folio distinto no se rechaza en falso.
 */
export function claveCompacta(
  serie: string | null | undefined,
  folio: string | null | undefined,
): string {
  return sinAcentosMayus(`${serie ?? ''}${folio ?? ''}`)
    .replace(/[^A-Z0-9Ñ]/g, '')
    .replace(/(^|[^0-9])0+(?=[0-9])/g, '$1');
}

/**
 * ¿Misma razón social emisora? NULL = COMODÍN (una factura sin emisora
 * identificada choca con cualquiera del mismo número). Dos emisoras
 * DISTINTAS con el mismo número NO chocan: cada una lleva su numeración.
 */
export function mismaEmisora(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return a == null || b == null || a === b;
}

/**
 * Serie EFECTIVA para agrupar y ordenar (el dato NO se reescribe): la serie
 * en mayúsculas si existe; si no, el prefijo de letras cuando el folio es
 * exactamente `LETRAS[-/espacio]DÍGITOS` («A-123» ⇒ «A»); si no, null.
 */
export function serieEfectiva(
  serie: string | null | undefined,
  folio: string | null | undefined,
): string | null {
  const s = (serie ?? '').trim();
  if (s) return s.toUpperCase();
  const m = /^([A-Za-zÑñ]+)[-\s]?\d+$/.exec((folio ?? '').trim());
  return m ? m[1].toUpperCase() : null;
}

/** «A-123» / «123» — la etiqueta de la factura (nunca vacía: folio es NOT NULL). */
export function etiquetaFactura(
  serie: string | null | undefined,
  folio: string,
): string {
  return etiquetaSerieFolio(serie, folio) ?? folio;
}

/** Serie normalizada: MAYÚSCULAS, sin espacios extremos; "" ⇒ null. */
export function normalizarSerie(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return s || null;
}

/** Folio normalizado: trim + espacios internos colapsados (mayúsculas intactas). */
export function normalizarFolio(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
}

/** UUID fiscal en MAYÚSCULAS; "" ⇒ null (el formato lo valida quien llama). */
export function normalizarUuidEntrada(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return s || null;
}

/** Texto libre opcional: trim; "" ⇒ null. */
export function textoONull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s || null;
}

/** «#297» · «#297 y #298» · «#297, #298 y #299». */
export function listaFolios(folios: ReadonlyArray<number>): string {
  const t = folios.map((f) => `#${f}`);
  if (t.length <= 1) return t.join('');
  return `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}`;
}

// ============================ ORDEN ============================

interface Ordenable {
  serie: string | null;
  folio: string;
  folio_num: unknown;
  created_at: string;
  fecha_emision: string;
}

function cmpTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Comparador del registro (función pura del contrato):
 *  - `folio_desc` (default): serie efectiva ASC → número DESC (nulls al
 *    final) → folio DESC → alta DESC;
 *  - `folio_asc`: serie efectiva ASC → número ASC (nulls al final) → folio
 *    ASC → alta ASC;
 *  - `fecha_desc`: fecha de emisión DESC → luego `folio_desc`.
 */
export function compararFacturas(
  orden: OrdenFacturas = 'folio_desc',
): (a: Ordenable, b: Ordenable) => number {
  const porNumero = (asc: boolean) => (a: Ordenable, b: Ordenable) => {
    const sa = serieEfectiva(a.serie, a.folio) ?? '';
    const sb = serieEfectiva(b.serie, b.folio) ?? '';
    const s = cmpTexto(sa, sb);
    if (s !== 0) return s;
    const na = numeroONull(a.folio_num);
    const nb = numeroONull(b.folio_num);
    if (na !== nb) {
      if (na == null) return 1;
      if (nb == null) return -1;
      return asc ? na - nb : nb - na;
    }
    const f = cmpTexto(a.folio.toUpperCase(), b.folio.toUpperCase());
    if (f !== 0) return asc ? f : -f;
    const c = cmpTexto(a.created_at ?? '', b.created_at ?? '');
    return asc ? c : -c;
  };
  if (orden === 'folio_asc') return porNumero(true);
  const desc = porNumero(false);
  if (orden === 'fecha_desc') {
    return (a, b) => {
      const f = cmpTexto(b.fecha_emision ?? '', a.fecha_emision ?? '');
      return f !== 0 ? f : desc(a, b);
    };
  }
  return desc;
}

// ============================ ALERTAS ============================

interface FacturaParaAlertas {
  id: string;
  estatus: string;
  pdf_path: string | null;
  es_parcial: boolean | null;
}

export interface AlertasCalculadas {
  porFactura: Map<string, AlertaFactura[]>;
  /** Vuelos con ≥ 2 VIGENTES y al menos una NO parcial. */
  vuelosDuplicados: Set<string>;
  /** Facturas VIGENTES por vuelo (para «otras_vigentes» y avisos). */
  vigentesPorVuelo: Map<string, string[]>;
}

/**
 * Alertas por factura (solo VIGENTES; una CANCELADA no lleva alertas):
 *  - `DUPLICADO_VUELO`: alguno de sus vuelos tiene ≥ 2 VIGENTES y al menos
 *    una NO es parcial (anticipo + finiquito marcados es correcto);
 *  - `SIN_PDF`, `SIN_VUELO`;
 *  - `VUELO_CANCELADO`: alguno de sus vuelos está CANCELADO.
 */
export function calcularAlertas(
  facturas: ReadonlyArray<FacturaParaAlertas>,
  ligas: ReadonlyArray<{
    factura_id: string;
    vuelo_id: string;
    vuelo?: { estado?: string | null } | null;
  }>,
): AlertasCalculadas {
  const porId = new Map(facturas.map((f) => [f.id, f]));
  const vuelosDeFactura = new Map<string, string[]>();
  const estadoVuelo = new Map<string, string>();
  const vigentesPorVuelo = new Map<string, string[]>();
  for (const l of ligas) {
    const f = porId.get(l.factura_id);
    if (!f) continue; // liga de una factura borrada: no cuenta
    (
      vuelosDeFactura.get(l.factura_id) ??
      vuelosDeFactura.set(l.factura_id, []).get(l.factura_id)!
    ).push(l.vuelo_id);
    if (l.vuelo?.estado) estadoVuelo.set(l.vuelo_id, l.vuelo.estado);
    if (f.estatus === 'VIGENTE') {
      (
        vigentesPorVuelo.get(l.vuelo_id) ??
        vigentesPorVuelo.set(l.vuelo_id, []).get(l.vuelo_id)!
      ).push(f.id);
    }
  }
  const vuelosDuplicados = new Set<string>();
  for (const [vid, ids] of vigentesPorVuelo) {
    if (ids.length < 2) continue;
    if (ids.some((id) => porId.get(id)?.es_parcial !== true)) {
      vuelosDuplicados.add(vid);
    }
  }
  const porFactura = new Map<string, AlertaFactura[]>();
  for (const f of facturas) {
    if (f.estatus !== 'VIGENTE') {
      porFactura.set(f.id, []);
      continue;
    }
    const vuelos = vuelosDeFactura.get(f.id) ?? [];
    const alertas: AlertaFactura[] = [];
    if (vuelos.some((v) => vuelosDuplicados.has(v))) {
      alertas.push('DUPLICADO_VUELO');
    }
    if (!f.pdf_path) alertas.push('SIN_PDF');
    if (vuelos.length === 0) alertas.push('SIN_VUELO');
    if (vuelos.some((v) => estadoVuelo.get(v) === 'CANCELADO')) {
      alertas.push('VUELO_CANCELADO');
    }
    porFactura.set(f.id, alertas);
  }
  return { porFactura, vuelosDuplicados, vigentesPorVuelo };
}

// ============================ HUECOS ============================

interface FacturaParaHuecos {
  serie: string | null;
  folio: string;
  folio_num: unknown;
  emisora_id: string | null;
}

/**
 * Folios FALTANTES por (emisora, serie efectiva), con los `folio_num` de TODAS
 * las no borradas (una CANCELADA ocupa su número). Aritmético: `total =
 * Σ(b − a − 1)` entre números consecutivos distintos — jamás se enumera un
 * rango enorme (un folio con un dígito de más daría millones). Solo se
 * listan los primeros `MAX_FALTANTES_LISTADOS`; `truncado` lo dice.
 */
export function huecosPorSerie(
  filas: ReadonlyArray<FacturaParaHuecos>,
  razonSocialDe: (emisoraId: string) => string | null = () => null,
): HuecoSerie[] {
  const grupos = new Map<
    string,
    { emisora: string | null; serie: string | null; nums: Set<number> }
  >();
  const emisorasVistas = new Set<string>();
  for (const f of filas) {
    emisorasVistas.add(f.emisora_id ?? '');
    const n = numeroONull(f.folio_num);
    if (n == null || !Number.isInteger(n) || n > Number.MAX_SAFE_INTEGER) {
      continue;
    }
    const serie = serieEfectiva(f.serie, f.folio);
    const llave = `${f.emisora_id ?? ''}|${serie ?? ''}`;
    const g =
      grupos.get(llave) ??
      grupos
        .set(llave, { emisora: f.emisora_id ?? null, serie, nums: new Set() })
        .get(llave)!;
    g.nums.add(n);
  }
  const variasEmisoras = emisorasVistas.size > 1;
  const out: HuecoSerie[] = [];
  for (const g of grupos.values()) {
    const nums = [...g.nums].sort((a, b) => a - b);
    if (nums.length < 2) continue;
    let total = 0;
    const faltantes: string[] = [];
    for (let i = 1; i < nums.length; i++) {
      const a = nums[i - 1];
      const b = nums[i];
      const hueco = b - a - 1;
      if (hueco <= 0) continue;
      total += hueco;
      for (
        let k = a + 1;
        k < b && faltantes.length < MAX_FALTANTES_LISTADOS;
        k++
      ) {
        faltantes.push(etiquetaSerieFolio(g.serie, k) ?? String(k));
      }
    }
    if (total <= 0) continue;
    const razon = g.emisora ? razonSocialDe(g.emisora) : null;
    const base = g.serie ?? '(sin serie)';
    out.push({
      emisora: g.emisora
        ? { id: g.emisora, razon_social: razon ?? 'Razón social' }
        : null,
      serie: g.serie,
      etiqueta_serie: variasEmisoras
        ? `${base} · ${razon ?? 'Sin emisora'}`
        : base,
      desde: nums[0],
      hasta: nums[nums.length - 1],
      total_faltantes: total,
      faltantes,
      truncado: total > faltantes.length,
    });
  }
  return out.sort((a, b) => cmpTexto(a.etiqueta_serie, b.etiqueta_serie));
}

// ============================ EMISOR ============================

/**
 * Nombre de empresa comparable: sin acentos, MAYÚSCULAS, sin signos y sin la
 * forma societaria final («S.A. de C.V.», «SAPI de CV», «S. de R.L.»…).
 */
export function normalizarNombreEmpresa(s: string | null | undefined): string {
  let t = sinAcentosMayus(s ?? '')
    .replace(/[^A-Z0-9Ñ&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sufijo =
    /\s+(S\s?A\s?P\s?I|S\s?A\s?B|S\s?A|S\s?DE\s?R\s?L|S\s?C|A\s?C|S\s?EN\s?C)(\s+DE\s+(C\s?V|R\s?L|I\s?P))*$/;
  for (let i = 0; i < 4; i++) {
    const sin = t.replace(sufijo, '').trim();
    if (sin === t || !sin) break;
    t = sin;
  }
  return t;
}

export interface EmisoraRef {
  id: string;
  razon_social: string;
  rfc: string | null;
  activa: boolean | null;
}

export interface VerificacionEmisor {
  emisora: { id: string; razon_social: string } | null;
  avisos: AvisoFactura[];
}

/**
 * ¿La factura la emitió una razón social de VuelaTour? Compara contra TODAS
 * las emisoras (activas primero: una factura vieja de una razón social ya
 * desactivada sigue reconociéndose): RFC igual ⇒ ok; si no, nombre
 * normalizado contenido uno en otro ⇒ ok. Con datos de emisor y sin
 * coincidencia ⇒ `EMISOR_NO_VUELATOUR`; si además ninguna emisora tiene RFC
 * capturado ⇒ `EMISOR_SIN_VERIFICAR` (hoy en prod las dos lo tienen NULL).
 */
export function verificarEmisor(
  emisorRfc: string | null | undefined,
  emisorNombre: string | null | undefined,
  emisoras: ReadonlyArray<EmisoraRef>,
): VerificacionEmisor {
  const rfc = (emisorRfc ?? '').trim().toUpperCase();
  const nombre = (emisorNombre ?? '').trim();
  if (!rfc && !nombre) return { emisora: null, avisos: [] };
  const ordenadas = [...emisoras].sort(
    (a, b) => Number(b.activa === true) - Number(a.activa === true),
  );
  const ref = (e: EmisoraRef) => ({ id: e.id, razon_social: e.razon_social });
  if (rfc) {
    const porRfc = ordenadas.find(
      (e) => (e.rfc ?? '').trim().toUpperCase() === rfc,
    );
    if (porRfc) return { emisora: ref(porRfc), avisos: [] };
  }
  const n = normalizarNombreEmpresa(nombre);
  if (n.length >= 4) {
    const porNombre = ordenadas.find((e) => {
      const en = normalizarNombreEmpresa(e.razon_social);
      return en.length >= 4 && (n.includes(en) || en.includes(n));
    });
    if (porNombre) return { emisora: ref(porNombre), avisos: [] };
  }
  const quien = nombre && rfc ? `${nombre} (${rfc})` : nombre || rfc;
  const avisos: AvisoFactura[] = [
    {
      code: 'EMISOR_NO_VUELATOUR',
      mensaje: `El emisor de esta factura es ${quien}, no una razón social de VuelaTour. ¿Seguro que es una factura que emitió VuelaTour?`,
      details: { emisor_rfc: rfc || null, emisor_nombre: nombre || null },
    },
  ];
  if (!emisoras.some((e) => (e.rfc ?? '').trim() !== '')) {
    avisos.push({
      code: 'EMISOR_SIN_VERIFICAR',
      mensaje:
        'Registra el RFC de tus razones sociales en Entidades fiscales para que el sistema reconozca tus facturas.',
    });
  }
  return { emisora: null, avisos };
}

// ============================ DUPLICADOS ============================

export interface CandidatoDuplicado {
  id: string;
  serie: string | null;
  folio: string;
  uuid: string | null;
  emisora_id: string | null;
}

/**
 * «¿Ya está registrada?» — UNA sola regla para el 409 del guardado y para el
 * banner de `leer-archivo`: por UUID primero (global entre no borradas), luego
 * por número (`claveCompacta` + `mismaEmisora`). `excluirId` = la propia
 * factura en una edición. Los candidatos ya vienen filtrados a no borradas.
 */
export function buscarYaRegistrada<T extends CandidatoDuplicado>(
  candidatos: ReadonlyArray<T>,
  p: {
    uuid?: string | null;
    serie?: string | null;
    folio?: string | null;
    emisora_id?: string | null;
    excluirId?: string | null;
  },
): { tipo: 'UUID' | 'FOLIO'; fila: T } | null {
  const otros = candidatos.filter((c) => c.id !== p.excluirId);
  const uuid = (p.uuid ?? '').trim().toUpperCase();
  if (uuid) {
    const porUuid = otros.find(
      (c) => (c.uuid ?? '').trim().toUpperCase() === uuid,
    );
    if (porUuid) return { tipo: 'UUID', fila: porUuid };
  }
  if (p.folio) {
    const clave = claveCompacta(p.serie, p.folio);
    if (clave) {
      const porNumero = otros.find(
        (c) =>
          claveCompacta(c.serie, c.folio) === clave &&
          mismaEmisora(c.emisora_id, p.emisora_id ?? null),
      );
      if (porNumero) return { tipo: 'FOLIO', fila: porNumero };
    }
  }
  return null;
}

/**
 * Texto de «ya registrada» (§6 del contrato):
 * «Ya está registrada: A-123 del vuelo #297.» · «… de los vuelos #297 y
 * #298.» · «… (sin vuelo ligado).» + « Está CANCELADA; si la vuelves a
 * emitir, usa otro folio.»
 */
export function mensajeFacturaExistente(
  etiqueta: string,
  folios: ReadonlyArray<number>,
  estatus: string,
): string {
  const ordenados = [...folios].sort((a, b) => a - b);
  let base: string;
  if (ordenados.length === 0) {
    base = `Ya está registrada: ${etiqueta} (sin vuelo ligado).`;
  } else if (ordenados.length === 1) {
    base = `Ya está registrada: ${etiqueta} del vuelo ${listaFolios(ordenados)}.`;
  } else {
    base = `Ya está registrada: ${etiqueta} de los vuelos ${listaFolios(ordenados)}.`;
  }
  return estatus === 'CANCELADA'
    ? `${base} Está CANCELADA; si la vuelves a emitir, usa otro folio.`
    : base;
}

export function facturaExistenteDe(
  fila: {
    id: string;
    serie: string | null;
    folio: string;
    uuid: string | null;
    estatus: string;
    fecha_emision: string;
  },
  vuelos: ReadonlyArray<{ id: string; folio: number }>,
): FacturaExistente {
  const etiqueta = etiquetaFactura(fila.serie, fila.folio);
  const estatus: EstatusFacturaEmitida =
    fila.estatus === 'CANCELADA' ? 'CANCELADA' : 'VIGENTE';
  const ordenados = [...vuelos].sort((a, b) => a.folio - b.folio);
  return {
    id: fila.id,
    etiqueta,
    uuid: fila.uuid ?? null,
    estatus,
    fecha_emision: fila.fecha_emision,
    vuelos: ordenados,
    mensaje: mensajeFacturaExistente(
      etiqueta,
      ordenados.map((v) => v.folio),
      estatus,
    ),
  };
}

/**
 * Patrón `ilike` SEGURO dentro de un `.or(...)` de PostgREST: comas y
 * paréntesis romperían el parser; `%`, `_`, `*` y comillas cambiarían el
 * patrón. Se sustituyen por `_` (comodín de UN carácter): el candidato es un
 * SUPERCONJUNTO y el filtro exacto se hace después en JS (`claveCompacta`).
 */
export function patronIlikeSeguro(texto: string): string {
  return texto.replace(/[%_,()*"'\\:]/g, '_');
}

// ============================ DATOS FISCALES ============================

/** Etiquetas es-MX de lo que le falta al cliente para facturarle (en orden). */
export function faltanDatosFiscales(
  cliente: {
    rfc?: string | null;
    razon_social_default?: string | null;
    regimen_fiscal_receptor?: string | null;
    uso_cfdi?: string | null;
    codigo_postal?: string | null;
  } | null,
): string[] {
  const vacio = (v: unknown) => typeof v !== 'string' || v.trim() === '';
  if (!cliente) {
    return [
      'RFC',
      'Razón social',
      'Régimen fiscal',
      'Uso de CFDI',
      'Código postal',
    ];
  }
  const out: string[] = [];
  if (vacio(cliente.rfc)) out.push('RFC');
  if (vacio(cliente.razon_social_default)) out.push('Razón social');
  if (vacio(cliente.regimen_fiscal_receptor)) out.push('Régimen fiscal');
  if (vacio(cliente.uso_cfdi)) out.push('Uso de CFDI');
  if (vacio(cliente.codigo_postal)) out.push('Código postal');
  return out;
}

// ============================ VUELO: TOTAL Y COBRO ============================

/** Total del vuelo por las FUENTES ÚNICAS (`monto_total_usd`, `totalMxnDeVuelo`). */
export function totalVueloDe(v: {
  monto_total_usd?: unknown;
  monto_total_mxn?: unknown;
  tc_usd_mxn?: unknown;
}): TotalVuelo {
  return {
    usd: numeroONull(v.monto_total_usd) ?? 0,
    mxn: totalMxnDeVuelo(v),
  };
}

/**
 * Insumos del semáforo de cobro de un vuelo + el espejo server
 * (`semaforo-cobro.util`). `status` = lo que devolvió `cobroStatus` para ese
 * vuelo (`null` = el lote falló: «Por cobrar», nunca un verde inventado).
 */
export function cobroResumenDe(
  v: {
    monto_total_usd?: unknown;
    cobrado?: boolean | null;
    cotizacion_abierta?: boolean | null;
    estado?: string | null;
  },
  status: { total_cobrado: number; sin_tc_count: number } | null | undefined,
  esInterno: boolean,
): CobroResumen {
  const monto = numeroONull(v.monto_total_usd) ?? 0;
  const estado = v.estado ?? '';
  const totalCobrado = status ? status.total_cobrado : null;
  const sinTc = status?.sin_tc_count ?? 0;
  const semaforo = estadoCobroSemaforo({
    montoTotalUsd: monto,
    cobrado: v.cobrado === true,
    totalCobradoUsd: totalCobrado,
    sinTcCount: sinTc,
    cotizacionAbierta: v.cotizacion_abierta === true,
    enCotizacion: estado === 'SOLICITUD' || estado === 'COTIZADO',
    cancelado: estado === 'CANCELADO',
    esInterno,
  });
  return {
    monto_total_usd: monto,
    total_cobrado_usd: totalCobrado,
    sin_tc_count: sinTc,
    cobrado: v.cobrado === true,
    cotizacion_abierta: v.cotizacion_abierta === true,
    estado_vuelo: estado,
    es_interno: esInterno,
    semaforo,
  };
}

/**
 * `TOTAL_DISTINTO_VUELO` (typo de monto, NO bloquea): solo con la factura
 * VIGENTE, NO parcial, que cubre EXACTAMENTE un vuelo que no es hijo de
 * grupo. Misma moneda: USD contra `monto_total_usd`, MXN contra
 * `totalMxnDeVuelo` (si es null no se compara). Diferencia > 1.00.
 */
export function avisoTotalDistintoVuelo(p: {
  estatus: string;
  es_parcial: boolean;
  moneda: string;
  total: number;
  etiqueta: string;
  vuelos: ReadonlyArray<{
    folio: number;
    grupo_id?: string | null;
    monto_total_usd?: unknown;
    monto_total_mxn?: unknown;
    tc_usd_mxn?: unknown;
  }>;
}): AvisoFactura | null {
  if (p.estatus !== 'VIGENTE' || p.es_parcial || p.vuelos.length !== 1) {
    return null;
  }
  const v = p.vuelos[0];
  if (v.grupo_id) return null;
  const moneda = p.moneda === 'MXN' ? 'MXN' : 'USD';
  const delVuelo =
    moneda === 'USD' ? numeroONull(v.monto_total_usd) : totalMxnDeVuelo(v);
  if (delVuelo == null || !(delVuelo > 0)) return null;
  if (Math.abs(redondear2(p.total - delVuelo)) <= 1) return null;
  return {
    code: 'TOTAL_DISTINTO_VUELO',
    mensaje: `La factura ${p.etiqueta} suma ${fmtDineroTexto(p.total, moneda)} y el vuelo #${v.folio} cotizó ${fmtDineroTexto(delVuelo, moneda)}. Revisa el total (si es un anticipo, márcala como parcial).`,
    details: {
      folio: v.folio,
      total_factura: p.total,
      total_vuelo: delVuelo,
      moneda,
    },
  };
}

// ============================ FILTROS Y TOTALES ============================

export interface FiltrosFacturas {
  q?: string;
  desde?: string;
  hasta?: string;
  cliente_id?: string;
  emisora_id?: string;
  serie?: string;
  estatus?: EstatusFacturaEmitida;
  vuelo_id?: string;
  alerta?: FiltroAlerta;
}

/** Lo que el filtro necesita saber de cada factura (ya calculado). */
export interface FacturaFiltrable {
  id: string;
  serie: string | null;
  folio: string;
  uuid: string | null;
  estatus: string;
  fecha_emision: string;
  receptor_nombre: string | null;
  receptor_rfc: string | null;
  cliente_id: string | null;
  cliente_nombre: string | null;
  emisora_id: string | null;
  vuelo_ids: string[];
  vuelo_folios: number[];
  alertas: AlertaFactura[];
}

const ALERTA_DE_FILTRO: Record<FiltroAlerta, AlertaFactura> = {
  duplicado_vuelo: 'DUPLICADO_VUELO',
  sin_pdf: 'SIN_PDF',
  sin_vuelo: 'SIN_VUELO',
  vuelo_cancelado: 'VUELO_CANCELADO',
};

/**
 * Filtro EN MEMORIA del registro (el volumen esperado es < 5,000/año). `q`
 * busca en serie, folio, etiqueta «A-123», UUID, receptor (nombre/RFC),
 * cliente y folio de vuelo («341» o «#341»), sin acentos ni mayúsculas.
 * Fechas de emisión = columna `date` ⇒ comparación directa (sin TZ).
 */
export function filtrarFacturas<T extends FacturaFiltrable>(
  filas: ReadonlyArray<T>,
  f: FiltrosFacturas,
): T[] {
  const q = normalizarBusqueda(f.q);
  const qFolioVuelo = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  const qCompacta = q ? claveCompacta(null, q) : '';
  const serie = f.serie ? f.serie.trim().toUpperCase() : null;
  const alerta = f.alerta ? ALERTA_DE_FILTRO[f.alerta] : null;
  return filas.filter((r) => {
    if (f.estatus && r.estatus !== f.estatus) return false;
    if (f.desde && r.fecha_emision < f.desde) return false;
    if (f.hasta && r.fecha_emision > f.hasta) return false;
    if (f.cliente_id && r.cliente_id !== f.cliente_id) return false;
    if (f.emisora_id) {
      if (f.emisora_id === 'SIN_EMISORA') {
        if (r.emisora_id != null) return false;
      } else if (r.emisora_id !== f.emisora_id) return false;
    }
    if (serie) {
      if (serie === 'SIN_SERIE') {
        if (r.serie != null && r.serie !== '') return false;
      } else if ((r.serie ?? '').toUpperCase() !== serie) return false;
    }
    if (f.vuelo_id && !r.vuelo_ids.includes(f.vuelo_id)) return false;
    if (alerta && !r.alertas.includes(alerta)) return false;
    if (q) {
      const etiqueta = etiquetaFactura(r.serie, r.folio);
      const campos = [
        r.serie,
        r.folio,
        etiqueta,
        r.uuid,
        r.receptor_nombre,
        r.receptor_rfc,
        r.cliente_nombre,
      ].map((c) => normalizarBusqueda(c));
      const enTexto = campos.some((c) => c && c.includes(q));
      const enClave =
        qCompacta.length > 0 && claveCompacta(r.serie, r.folio) === qCompacta;
      const enVuelo =
        qFolioVuelo != null && r.vuelo_folios.includes(qFolioVuelo);
      if (!enTexto && !enClave && !enVuelo) return false;
    }
    return true;
  });
}

/** Totales por moneda de las VIGENTES (jamás se suma USD con MXN). */
export function totalesPorMoneda(
  filas: ReadonlyArray<{ estatus: string; moneda: string; total: unknown }>,
): TotalMoneda[] {
  const acc = new Map<MonedaFactura, number>();
  for (const f of filas) {
    if (f.estatus !== 'VIGENTE') continue;
    const m: MonedaFactura = f.moneda === 'USD' ? 'USD' : 'MXN';
    acc.set(m, redondear2((acc.get(m) ?? 0) + (numeroONull(f.total) ?? 0)));
  }
  return (['MXN', 'USD'] as MonedaFactura[])
    .filter((m) => acc.has(m))
    .map((m) => ({ moneda: m, total: acc.get(m)! }));
}

// ============================ VUELOS CANDIDATOS ============================

export type BusquedaVuelo =
  | { tipo: 'folio'; folio: number }
  | { tipo: 'dia'; dia: string }
  | { tipo: 'texto'; texto: string }
  | { tipo: 'vacia' };

/**
 * Interpreta el buscador del selector de vuelos: «341» / «#341» ⇒ folio;
 * «2026-09-27» o «27/09[/2026]» ⇒ día Cancún (sin año ⇒ el del `hoy`
 * Cancún); cualquier otra cosa ⇒ texto (cliente).
 */
export function interpretarBusquedaVuelo(
  q: string | null | undefined,
  hoy: string,
): BusquedaVuelo {
  const t = (q ?? '').trim();
  if (!t) return { tipo: 'vacia' };
  if (/^#?\d+$/.test(t)) {
    // Un folio absurdo (más dígitos de los que caben en bigint / en un
    // entero seguro de JS) viajaría a PostgREST como `1e+20` y la BD
    // respondería 500 («invalid input syntax for type bigint»): ningún vuelo
    // tiene ese folio, así que la búsqueda simplemente no encuentra nada.
    const folio = Number(t.replace('#', ''));
    return Number.isSafeInteger(folio)
      ? { tipo: 'folio', folio }
      : { tipo: 'texto', texto: t };
  }
  // Solo fechas que EXISTEN: «31/02» o «2026-13-45» llegaban a PostgREST
  // como `2026-02-31T00:00:00-05:00` y la BD respondía 500 («date/time field
  // value out of range») mientras Mari tecleaba en el buscador.
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) && esDiaValido(t)) {
    return { tipo: 'dia', dia: t };
  }
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    let yyyy = m[3] ? Number(m[3]) : Number(hoy.slice(0, 4));
    if (yyyy < 100) yyyy += 2000;
    const dia = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    if (esDiaValido(dia)) return { tipo: 'dia', dia };
  }
  return { tipo: 'texto', texto: t };
}

/** ¿'YYYY-MM-DD' es un día del calendario que existe? (sin TZ: mediodía UTC). */
function esDiaValido(dia: string): boolean {
  const d = new Date(`${dia}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dia;
}

/** Ruta de puntos (origen del 1er tramo + destinos) o [origen, destino]. */
export function rutaIatasDe(
  escalas: ReadonlyArray<{
    origen_iata?: string | null;
    destino_iata?: string | null;
  }>,
  respaldo: { origen_iata?: string | null; destino_iata?: string | null },
): string[] {
  if (escalas.length > 0) {
    return [
      escalas[0].origen_iata ?? '',
      ...escalas.map((e) => e.destino_iata ?? ''),
    ].filter(Boolean);
  }
  return [respaldo.origen_iata ?? '', respaldo.destino_iata ?? ''].filter(
    Boolean,
  );
}

/** Parte un arreglo en lotes (consultas `.in` de ≤ 200 ids). */
export function enLotes<T>(arr: ReadonlyArray<T>, tam = LOTE_IDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += tam) out.push(arr.slice(i, i + tam));
  return out;
}
