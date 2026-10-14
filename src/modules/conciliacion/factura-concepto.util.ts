/**
 * «¿QUÉ FACTURA DICE EL CONCEPTO DEL BANCO?» — FUENTE ÚNICA (13-oct-2026,
 * lote 2, API 0.0.75, invariante 69). PURO: sin Nest, sin BD, sin red.
 *
 * Caso real: los SPEI de SAESA traen en su concepto el número de la factura
 * que pagan («SEL TRANSF. INTERBANCARIA SPEI BANORTE fact vip 7360»); en
 * Corner es la PREFACTURA («pre factura corner 4409»), cuyo número es el
 * folio de la factura recibida. Aquí, y solo aquí, se lee ese número:
 * - la lista de Conciliación pinta el chip «Factura 7360» con la coherencia
 *   contra los gastos ligados (`estadoLigados`) y si la MISMA factura sale en
 *   otro pago (`repeticionesDeFactura`);
 * - «Vincular gasto» marca con ★ el candidato cuyo folio coincide
 *   (`coincideFacturaConGasto`, dentro de su nivel de monto: jamás liga ni
 *   preselecciona, y el auto-cruce NO la usa);
 * - el enriquecimiento de la re-subida (`enriquecer-descripcion.util`) la usa
 *   para la regla FOLIO de los gemelos.
 * El panel NO parsea: pinta lo que llega.
 *
 * PRECISIÓN ANTES QUE COBERTURA: un número dudoso (fecha, monto con
 * decimales, más de 8 dígitos —recibos SPEI, CLABE—, un mes después de la
 * clave) corta sin número. Falsos negativos aceptados: «Folio 383»,
 * «COT 337», «… F A0422 …, SPID» de HSBC USD.
 */
import { primeraLinea } from './auto-cruce.util';
import { difDias } from './paywise-cruce.util';

export type TipoFacturaConcepto = 'FACTURA' | 'PREFACTURA';

/** Un número de factura leído (del concepto del banco o de un folio). */
export interface NumeroFactura {
  /** Serie alfabética («A», «FEACZM») o null. */
  serie: string | null;
  /** Dígitos SIN ceros a la izquierda (lo que se compara). */
  digitos: string;
  /** Como se imprimió: '7360', '0456', 'A-123'. */
  texto: string;
}

/** Lo que dice el concepto del banco sobre la(s) factura(s) que paga. */
export interface FacturaConcepto {
  tipo: TipoFacturaConcepto;
  numeros: NumeroFactura[];
  /** «Factura 7360» · «Facturas 7359 · 7360» · «Prefactura 4409». */
  texto: string;
  /** Palabras entre la clave y el número de la PRIMERA clave con número («VIP»). */
  pista: string | null;
}

/** Tokens que se miran después de la clave («fact vip saesa sa de cv 7360»). */
export const VENTANA_TOKENS_FACTURA = 6;
/** Palabras de pista permitidas: la 5.ª corta la clave. */
export const PISTAS_FACTURA_MAX = 4;
/** Números que se juntan de todo el texto. */
export const NUMEROS_FACTURA_MAX = 5;
/** «También en otro pago»: ventana ±días. */
export const REPETIDA_DIAS = 120;
/** «También en otro pago»: máximo de filas que viajan. */
export const REPETIDAS_MAX = 5;
/** Sin pista en alguno de los dos lados, el número debe tener ≥ 4 dígitos. */
export const DIGITOS_SIN_PISTA_MIN = 4;

const CLAVE = /^(PRE)?(FACTURAS?|FACTS?|FACS?)$/;
const CLAVE_PEGADA = /^(PRE)?(FACTURAS?|FACTS?|FACS?)[-#]?(\d[\dA-Z/-]*)$/;
const RELLENOS = new Set([
  'NO',
  'NUM',
  'NUMERO',
  'NRO',
  'N',
  'DE',
  'DEL',
  'LA',
  'EL',
  'LOS',
  'LAS',
  '#',
]);
const MESES = new Set([
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'SETIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
  'ENE',
  'FEB',
  'MAR',
  'ABR',
  'MAY',
  'JUN',
  'JUL',
  'AGO',
  'SEP',
  'SEPT',
  'SET',
  'OCT',
  'NOV',
  'DIC',
]);
/** Separadores de un encadenado («7359 Y 7360», «7359/7360», «7359, 7360»). */
const ENCADENADORES = new Set(['Y', 'E', ',', '/', '&', '-']);
const FECHA = /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/;

/**
 * Tokens del concepto: sin acentos, MAYÚSCULAS; `;:()[]{}"'«»` ⇒ espacio;
 * ',' y '&' son tokens propios; sin el '.' final ('FACT.' ⇒ FACT); un '#'
 * inicial es token propio; una fecha («12/09/2026») queda entera y cualquier
 * otro token con '/' se parte ('7359/7360' ⇒ 7359 / 7360); una clave pegada
 * a los dígitos se separa (FACT7360, FACT#7360, FAC-123).
 */
export function tokensConcepto(texto: string | null | undefined): string[] {
  if (typeof texto !== 'string') return [];
  const t = texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[;:()[\]{}"'«»]/g, ' ')
    .replace(/([,&])/g, ' $1 ');
  const out: string[] = [];
  for (const crudo of t.split(/\s+/)) {
    let raw = crudo.replace(/\.+$/, '');
    if (!raw) continue;
    if (raw.startsWith('#')) {
      out.push('#');
      raw = raw.slice(1);
      if (!raw) continue;
    }
    if (FECHA.test(raw)) {
      out.push(raw);
      continue;
    }
    const pegada = CLAVE_PEGADA.exec(raw);
    if (pegada) {
      out.push(`${pegada[1] ?? ''}${pegada[2]}`);
      raw = pegada[3];
    }
    if (raw.includes('/')) {
      raw.split('/').forEach((parte, i) => {
        if (i > 0) out.push('/');
        if (parte) out.push(parte);
      });
      continue;
    }
    out.push(raw);
  }
  return out;
}

const todoCeros = (s: string) => /^0+$/.test(s);
const sinCeros = (s: string) => s.replace(/^0+/, '');

/** Un token del concepto ⇒ número(s) de factura, o null si no es uno válido. */
function numerosDeToken(tok: string | undefined): NumeroFactura[] | null {
  if (!tok || FECHA.test(tok)) return null;
  let m = /^(\d{2,8})$/.exec(tok);
  if (m) {
    return todoCeros(m[1])
      ? null
      : [{ serie: null, digitos: sinCeros(m[1]), texto: m[1] }];
  }
  m = /^(\d{2,8})-(\d{2,8})$/.exec(tok);
  if (m) {
    if (todoCeros(m[1]) || todoCeros(m[2])) return null;
    return [m[1], m[2]].map((x) => ({
      serie: null,
      digitos: sinCeros(x),
      texto: x,
    }));
  }
  m = /^([A-Z]{1,6})-?(\d{1,8})$/.exec(tok);
  if (m) {
    return todoCeros(m[2])
      ? null
      : [{ serie: m[1], digitos: sinCeros(m[2]), texto: tok }];
  }
  return null;
}

const mismaLlave = (a: NumeroFactura, b: NumeroFactura) =>
  a.digitos === b.digitos && (a.serie ?? '') === (b.serie ?? '');

/** «Factura 7360» · «Facturas 7359 · 7360» · «Prefactura 4409». */
function textoFactura(
  tipo: TipoFacturaConcepto,
  numeros: readonly NumeroFactura[],
): string {
  const base =
    tipo === 'PREFACTURA'
      ? numeros.length === 1
        ? 'Prefactura'
        : 'Prefacturas'
      : numeros.length === 1
        ? 'Factura'
        : 'Facturas';
  return `${base} ${numeros.map((n) => n.texto).join(' · ')}`;
}

/**
 * ¿Qué factura(s) cita el texto? Clave = FACTURA(S) / FACT(S) / FAC(S), con
 * PRE pegado o separado (prefactura); NO son clave FACTURACION, FACTOR,
 * FOLIO, COT, REF ni F. Tras la clave se mira una ventana de
 * `VENTANA_TOKENS_FACTURA` tokens: se saltan rellenos (NO, NUM, DE, '#'…) y
 * letras sueltas; las palabras de 2–15 letras son la pista (la 5.ª corta);
 * un MES, otra clave o 'PRE' cortan; el PRIMER token con dígitos decide
 * (2–8 dígitos no todos ceros, rango «7360-7361», serie «A-123»; cualquier
 * otro —fecha, '2231.38', más de 8 dígitos— corta sin número) y se
 * encadena con Y / E / , / '/' / & / -. Se juntan todas las claves sin
 * repetir (≤ 5 números); PREFACTURA solo si TODAS las claves con número lo
 * eran. null = el texto no cita ninguna factura.
 */
export function facturaDeConcepto(
  texto: string | null | undefined,
): FacturaConcepto | null {
  const tk = tokensConcepto(texto);
  const numeros: NumeroFactura[] = [];
  let todasPre = true;
  let alguna = false;
  let pista: string | null = null;
  for (let i = 0; i < tk.length; i++) {
    let pre = false;
    let j: number;
    if (tk[i] === 'PRE' && CLAVE.test(tk[i + 1] ?? '')) {
      pre = true;
      j = i + 2;
    } else if (CLAVE.test(tk[i])) {
      pre = tk[i].startsWith('PRE');
      j = i + 1;
    } else {
      continue;
    }
    const pistas: string[] = [];
    let encontrados: NumeroFactura[] | null = null;
    let k = j;
    for (; k < tk.length && k < j + VENTANA_TOKENS_FACTURA; k++) {
      const t = tk[k];
      if (RELLENOS.has(t) || /^[A-Z]$/.test(t)) continue;
      if (/^[A-Z]{2,15}$/.test(t)) {
        if (MESES.has(t) || CLAVE.test(t) || t === 'PRE') break;
        pistas.push(t);
        if (pistas.length > PISTAS_FACTURA_MAX) break;
        continue;
      }
      if (/\d/.test(t)) {
        const ids = numerosDeToken(t);
        if (!ids) break;
        encontrados = [...ids];
        let m = k + 1;
        while (ENCADENADORES.has(tk[m]) && tk[m + 1] !== undefined) {
          const mas = numerosDeToken(tk[m + 1]);
          if (!mas) break;
          encontrados.push(...mas);
          m += 2;
        }
        k = m;
        break;
      }
      break;
    }
    if (encontrados) {
      alguna = true;
      if (!pre) todasPre = false;
      if (pista === null && pistas.length > 0) pista = pistas.join(' ');
      for (const n of encontrados) {
        if (!numeros.some((x) => mismaLlave(x, n))) numeros.push(n);
      }
      i = k - 1;
    }
  }
  if (!alguna || numeros.length === 0) return null;
  const nums = numeros.slice(0, NUMEROS_FACTURA_MAX);
  const tipo: TipoFacturaConcepto = todasPre ? 'PREFACTURA' : 'FACTURA';
  return { tipo, numeros: nums, texto: textoFactura(tipo, nums), pista };
}

// =======================================================================
// COMPARACIÓN CONTRA LOS FOLIOS DEL GASTO
// =======================================================================

/**
 * Folio de un gasto ⇒ número comparable, o null. MAYÚSCULAS y recortado;
 * `^([A-Z]{1,10})?[\s-]*0*(\d{1,12})(?:[\s-]*[A-Z]{1,2})?$`; «CFDI …» ⇒
 * null; 2–8 dígitos (1–8 con serie). 'A-0411' ⇒ A/411, 'A 9850',
 * 'FEACZM-72128', '7352-A' ⇒ 7352. Un recibo SPEI ('55276014805', más de 8
 * dígitos) o un folio alfanumérico largo no cuentan.
 */
export function numeroDeFolio(
  folio: string | number | null | undefined,
): NumeroFactura | null {
  if (typeof folio !== 'string' && typeof folio !== 'number') return null;
  const original = String(folio).trim();
  const t = original.toUpperCase();
  if (!t || /^CFDI\b/.test(t)) return null;
  const m = /^([A-Z]{1,10})?[\s-]*0*(\d{1,12})(?:[\s-]*[A-Z]{1,2})?$/.exec(t);
  if (!m) return null;
  const serie = m[1] ?? null;
  const dig = m[2];
  if (todoCeros(dig)) return null;
  const min = serie ? 1 : 2;
  if (dig.length < min || dig.length > 8) return null;
  return { serie, digitos: dig, texto: original };
}

/**
 * ¿Es la MISMA factura? Mismos dígitos (al menos 2) y la serie igual o
 * ausente en alguno de los dos (73 ≠ 1073; A-123 ≠ B-123; A-123 = 123).
 */
export function mismoNumero(a: NumeroFactura, b: NumeroFactura): boolean {
  return (
    a.digitos.length >= 2 &&
    a.digitos === b.digitos &&
    (!a.serie || !b.serie || a.serie === b.serie)
  );
}

/** Lo que un gasto dice de su factura (cualquiera de sus cuatro fuentes). */
export interface FoliosGasto {
  folio_ticket?: string | null;
  /** `valor_ia_extraido->>folio`. */
  ia_folio?: string | null;
  /** Factura recibida ligada (`serie`, `folio`). */
  factura?: { serie?: string | null; folio?: string | null } | null;
  /** Notas del gasto: solo cuenta «fact NNNN» de la PRIMERA línea. */
  notas?: string | null;
}

const textoONull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim()
    ? v
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : null;

/**
 * Fila CRUDA de PostgREST ⇒ `FoliosGasto`. El embed `factura` puede venir
 * como objeto o como arreglo de uno; la nota llega como `notas`, `notas_fc`
 * (alias de la lista) o `notas_primera_linea` (lotes).
 */
export function foliosDeGastoCrudo(
  fila: Record<string, unknown> | null | undefined,
): FoliosGasto {
  if (!fila) return {};
  const crudo = fila.factura;
  const factura = (Array.isArray(crudo) ? (crudo[0] ?? null) : crudo) as
    | { serie?: unknown; folio?: unknown }
    | null
    | undefined;
  return {
    folio_ticket: textoONull(fila.folio_ticket),
    ia_folio: textoONull(fila.ia_folio),
    factura:
      factura && typeof factura === 'object'
        ? { serie: textoONull(factura.serie), folio: textoONull(factura.folio) }
        : null,
    notas:
      textoONull(fila.notas) ??
      textoONull(fila.notas_fc) ??
      textoONull(fila.notas_primera_linea),
  };
}

/**
 * Números de factura de UN gasto, sin repetir: la serie-folio de la factura
 * recibida, `folio_ticket`, el folio de la IA y «fact NNNN» (o «pre factura
 * NNNN») en la PRIMERA línea de las notas —así se captura cuando una factura
 * ampara VARIOS gastos: `uq_gasto_folio_ticket_norm` es único desde 4
 * caracteres y el segundo gasto rebotaría con 409—.
 */
export function numerosDeGasto(f: FoliosGasto): NumeroFactura[] {
  const out: NumeroFactura[] = [];
  const agregar = (n: NumeroFactura | null | undefined) => {
    if (n && !out.some((x) => mismaLlave(x, n))) out.push(n);
  };
  const folioRecibida = textoONull(f.factura?.folio);
  if (folioRecibida) {
    const serie = textoONull(f.factura?.serie);
    agregar(
      numeroDeFolio([serie, folioRecibida].filter(Boolean).join('-')) ??
        numeroDeFolio(folioRecibida),
    );
  }
  agregar(numeroDeFolio(f.folio_ticket));
  agregar(numeroDeFolio(f.ia_folio));
  const nota = facturaDeConcepto(primeraLinea(f.notas));
  for (const n of nota?.numeros ?? []) agregar(n);
  return out;
}

/** ¿Alguno de los números del concepto es el de este gasto? */
export function coincideFacturaConGasto(
  fc: FacturaConcepto,
  f: FoliosGasto,
): boolean {
  const delGasto = numerosDeGasto(f);
  return fc.numeros.some((n) => delGasto.some((g) => mismoNumero(n, g)));
}

export type EstadoLigadosFactura =
  | 'COINCIDE'
  | 'PARCIAL'
  | 'NO_COINCIDE'
  | 'SIN_FOLIO';

export interface LigadosFactura {
  estado: EstadoLigadosFactura;
  /** Números de los gastos ligados (como se imprimieron, ≤ 5). */
  folios: string[];
  /** Números del concepto que ningún gasto ligado tiene. */
  faltan: string[];
}

/**
 * Coherencia del concepto con los gastos LIGADOS al cargo: sin gastos ⇒
 * null; ningún gasto con número ⇒ SIN_FOLIO; si no, `faltan` = números del
 * concepto que ningún gasto tiene y el estado es NO_COINCIDE (faltan todos),
 * COINCIDE (no falta ninguno y todo gasto con número trae uno del concepto)
 * o PARCIAL. Una PREFACTURA cuenta: en Corner su número es el folio de la
 * factura recibida.
 */
export function estadoLigados(
  fc: FacturaConcepto,
  gastos: readonly FoliosGasto[],
): LigadosFactura | null {
  if (gastos.length === 0) return null;
  const porGasto = gastos.map((g) => numerosDeGasto(g));
  const todos = porGasto.flat();
  const textosConcepto = fc.numeros.map((n) => n.texto);
  if (todos.length === 0) {
    return { estado: 'SIN_FOLIO', folios: [], faltan: textosConcepto };
  }
  const faltan = fc.numeros
    .filter((n) => !todos.some((g) => mismoNumero(n, g)))
    .map((n) => n.texto);
  const cadaGastoCoincide = porGasto.every(
    (ns) =>
      ns.length === 0 ||
      ns.some((g) => fc.numeros.some((n) => mismoNumero(n, g))),
  );
  const estado: EstadoLigadosFactura =
    faltan.length === fc.numeros.length
      ? 'NO_COINCIDE'
      : faltan.length === 0 && cadaGastoCoincide
        ? 'COINCIDE'
        : 'PARCIAL';
  const folios: string[] = [];
  for (const g of todos) if (!folios.includes(g.texto)) folios.push(g.texto);
  return { estado, folios: folios.slice(0, 5), faltan };
}

/**
 * ¿Dos conceptos hablan del mismo proveedor? Si los dos traen pista, deben
 * compartir al menos una palabra (VIP con VIP; VIP ≠ PALMA); si falta en
 * alguno, el número debe tener ≥ `DIGITOS_SIN_PISTA_MIN` dígitos («73» a
 * secas es demasiado corto para afirmar nada).
 */
export function pistasCompatibles(
  a: FacturaConcepto,
  b: FacturaConcepto,
  n: NumeroFactura,
): boolean {
  if (a.pista && b.pista) {
    const pb = b.pista.split(' ');
    return a.pista.split(' ').some((w) => pb.includes(w));
  }
  return n.digitos.length >= DIGITOS_SIN_PISTA_MIN;
}

/** Fila del universo de `repetida_en` (movimientos con «fac» en el concepto). */
export interface FilaUniversoFactura {
  id: string;
  fecha: string | null;
  tipo: string | null;
  monto: number;
  descripcion: string | null;
  conciliado: boolean;
  /** Alias de la cuenta del movimiento. */
  cuenta: string | null;
}

/** Otra fila del banco que cita la MISMA factura («también en otro pago»). */
export interface RepeticionFactura {
  movimiento_id: string;
  fecha: string | null;
  monto: number;
  cuenta: string | null;
  descripcion: string | null;
  conciliado: boolean;
}

/**
 * Filas del universo (cualquier cuenta) del MISMO tipo, a ≤ `dias` de la
 * fecha, que citan un número igual (`mismoNumero`) con pistas compatibles.
 * Orden por fecha e id; ≤ `REPETIDAS_MAX`. Un pago en partes también sale
 * aquí: es informativo, nunca bloquea.
 */
export function repeticionesDeFactura(
  fila: { id: string; fecha: string; tipo: string; fc: FacturaConcepto },
  universo: readonly FilaUniversoFactura[],
  dias: number = REPETIDA_DIAS,
): RepeticionFactura[] {
  const out: FilaUniversoFactura[] = [];
  for (const u of universo) {
    if (u.id === fila.id || u.tipo !== fila.tipo || !u.fecha) continue;
    if (difDias(fila.fecha, u.fecha) > dias) continue;
    const fu = facturaDeConcepto(u.descripcion);
    if (!fu) continue;
    const comparte = fila.fc.numeros.some((n) =>
      fu.numeros.some(
        (m) => mismoNumero(n, m) && pistasCompatibles(fila.fc, fu, n),
      ),
    );
    if (comparte) out.push(u);
  }
  out.sort((a, b) =>
    (a.fecha ?? '') !== (b.fecha ?? '')
      ? (a.fecha ?? '') < (b.fecha ?? '')
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
  return out.slice(0, REPETIDAS_MAX).map((u) => ({
    movimiento_id: u.id,
    fecha: u.fecha,
    monto: u.monto,
    cuenta: u.cuenta,
    descripcion: u.descripcion,
    conciliado: u.conciliado,
  }));
}

/** `factura_concepto` de una fila de `GET /v1/conciliacion/movimientos`. */
export interface FacturaConceptoRespuesta {
  tipo: TipoFacturaConcepto;
  numeros: string[];
  texto: string;
  pista: string | null;
  /** null en ABONOS, filas sin gasto o si el lote no se pudo leer. */
  ligados: LigadosFactura | null;
  /** null = no verificado (la lectura falló o llegó al tope); [] = no se repite. */
  repetida_en: RepeticionFactura[] | null;
}

/** Forma del contrato (los números viajan como texto). */
export function facturaConceptoParaRespuesta(
  fc: FacturaConcepto,
  ligados: LigadosFactura | null,
  repetidaEn: RepeticionFactura[] | null,
): FacturaConceptoRespuesta {
  return {
    tipo: fc.tipo,
    numeros: fc.numeros.map((n) => n.texto),
    texto: fc.texto,
    pista: fc.pista,
    ligados,
    repetida_en: repetidaEn,
  };
}
