/**
 * RELECTURA CON IA DEL FOLIO DE LOS COMPROBANTES (6-oct-2026, API 0.0.58,
 * invariante 46 del CLAUDE.md). PURO: sin Nest ni Supabase.
 *
 * Pedido del cliente: el número de factura en «Notas» del Excel de
 * conciliación sale solo si el gasto tiene folio (invariante 44). En prod
 * (6-oct) 477 gastos con foto no tenían NINGÚN folio; la IA ya había leído
 * casi todas esas fotos pero devolvió el folio vacío (facturas de ASUR de
 * principios de septiembre, antes de afinar el prompt). El cron
 * `gastos-releer-folio` (`folio-relectura.service.ts`) las vuelve a leer y
 * aquí vive lo que decide con cada lectura:
 *   - qué gastos entran y en qué orden (`loteRelectura`,
 *     `corteCapturadosHasta`, `ordenarCandidatos`);
 *   - qué archivos se leen y si siguen siendo los del gasto al escribir
 *     (`archivosDelComprobante`, `mismoComprobante`);
 *   - qué se hizo con la lectura (`evaluarLecturaFolio`,
 *     `clasificarMotivoLectura`, `falloSinCosto`);
 *   - qué pasa con un gasto que falla una y otra vez (`registrarFallo`,
 *     `destinoTrasFallo`);
 *   - qué se escribe (`lecturaConFolio`, `lineaFolioDuplicado`,
 *     `notasConLinea`, `fotosAdicionalesDe`).
 * El folio que se guarda lo decide `folio-ticket.util#folioTicketDeLectura`
 * (la MISMA regla que la captura).
 */
import { folioTicketDeLectura } from './folio-ticket.util';

/** Gastos que relee cada corrida (cada 5 min) sin configuración. */
export const FOLIOS_RELEER_LOTE_DEFAULT = 15;
/** Tope del lote (una lectura con Opus tarda 20–40 s). */
export const FOLIOS_RELEER_LOTE_MAX = 50;
/** `fecha_gasto` mínima sin configuración (lo que concilia la oficina). */
export const FOLIOS_RELEER_DESDE_DEFAULT = '2026-09-01';
/**
 * Último día (Cancún, inclusive) de CAPTURA que entra sin configuración.
 * Lo capturado después se leyó con el prompt afinado del 2-oct-2026 y es
 * lo que piloto y oficina siguen editando: no se relee.
 */
export const FOLIOS_RELEER_CAPTURADOS_HASTA_DEFAULT = '2026-10-05';
/** Categoría del consumo de IA (`ia_uso.categoria`). */
export const CATEGORIA_IA_RELEER_FOLIO = 'RELEER_FOLIO';
/**
 * Gastos con fallo transitorio que se recuerdan (en memoria). Holgado a
 * propósito: la cola por default es de 118 y aun con `folios_releer_desde`
 * en julio (477) cabe completa; olvidar a uno lo regresaría a su lugar con
 * sus contadores en cero.
 */
export const POSTERGADOS_MAX = 500;
/**
 * Un gasto que falló (transitorio o Storage) no se vuelve a intentar antes
 * de este lapso (revisión 6-oct-2026): con la cola ya vacía, un gasto que
 * siempre falla se leía en CADA corrida de 5 min.
 */
export const REINTENTO_POSTERGADO_MS = 60 * 60 * 1000;
/**
 * Fallos «con la IA viva» (ver `registrarFallo`) del MISMO gasto que lo
 * sellan como ilegible: el problema es ese comprobante, no pyservices.
 */
export const FALLOS_CON_IA_PARA_SELLAR = 3;
/**
 * Intentos fallidos que pudieron costar créditos (`falloSinCosto` = false)
 * tras los cuales el gasto sale de la cola de ESTE proceso SIN sellarse
 * (no hay prueba de que el comprobante sea el problema). Un reinicio del API
 * lo devuelve a la cola. Es el tope del gasto que, solo en la cola, falla
 * siempre (nadie más contesta y la prueba de «IA viva» nunca llega).
 */
export const INTENTOS_MAX_POR_GASTO = 6;

/** Lote saneado: entero 1–50; cualquier otra cosa ⇒ el default. */
export function loteRelectura(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return FOLIOS_RELEER_LOTE_DEFAULT;
  return Math.min(Math.floor(n), FOLIOS_RELEER_LOTE_MAX);
}

/**
 * Corte EXCLUSIVO de `created_at` para «capturados hasta `dia`» (pared
 * Cancún, invariante 4): el inicio del día SIGUIENTE a las 00:00 −05:00.
 * `2026-10-05` ⇒ `2026-10-06T00:00:00-05:00` (se filtra con `lt`).
 */
export function corteCapturadosHasta(dia: string): string {
  const t = new Date(`${dia}T00:00:00Z`).getTime() + 24 * 3600 * 1000;
  return `${new Date(t).toISOString().slice(0, 10)}T00:00:00-05:00`;
}

/**
 * Lo que el cron recuerda de un gasto que falló sin sellarse (en memoria:
 * un reinicio lo olvida y el gasto vuelve a su lugar con todo en cero).
 */
export interface EstadoPostergado {
  /** Intentos fallidos que PUDIERON costar créditos (`falloSinCosto` no). */
  intentos: number;
  /** De esos, los que fallaron con la IA contestando a otros gastos. */
  conIa: number;
  /** Epoch ms del primer fallo (de cualquier tipo). */
  primerFallo: number;
  /** Epoch ms del último fallo (de cualquier tipo). */
  ultimoIntento: number;
  /** Agotó `INTENTOS_MAX_POR_GASTO` sin prueba: fuera de la cola. */
  retirado: boolean;
}

/**
 * Orden de la corrida: los candidatos tal como salen de la consulta
 * (`fecha_gasto` desc) y AL FINAL los postergados (fallo en una corrida
 * anterior), del que falló hace más tiempo al más reciente; se toman
 * `lote`. Un postergado se reintenta solo si pasó `REINTENTO_POSTERGADO_MS`
 * desde su último fallo, y uno `retirado` ya no (hasta reiniciar el API).
 * Así dos fotos que siempre tumban la lectura no encabezan la cola (con dos
 * fallos seguidos la corrida se corta y el lote sale siempre en el mismo
 * orden) ni se leen en cada corrida cuando la cola ya se vació.
 */
export function ordenarCandidatos<T extends { id: string }>(
  filas: readonly T[],
  postergados: ReadonlyMap<
    string,
    Pick<EstadoPostergado, 'ultimoIntento' | 'retirado'>
  >,
  lote: number,
  ahora: number,
): T[] {
  const libres = filas.filter((f) => !postergados.has(f.id));
  const listos = filas
    .filter((f) => {
      const p = postergados.get(f.id);
      return (
        !!p && !p.retirado && ahora - p.ultimoIntento >= REINTENTO_POSTERGADO_MS
      );
    })
    .sort(
      (a, b) =>
        postergados.get(a.id)!.ultimoIntento -
        postergados.get(b.id)!.ultimoIntento,
    );
  return [...libres, ...listos].slice(0, Math.max(0, lote));
}

/**
 * Tipo de fallo que el cron registra contra UN gasto:
 * - `STORAGE`: no se pudo bajar/firmar el archivo (red); la IA no se llamó.
 * - `TRANSITORIO` / `RESPUESTA_IA`: la lectura falló (`clasificarMotivoLectura`).
 * - `ESCRITURA`: la IA leyó pero la BD no guardó (error o CAS agotado).
 */
export type FalloGasto =
  | 'STORAGE'
  | 'TRANSITORIO'
  | 'RESPUESTA_IA'
  | 'ESCRITURA';

/**
 * Estado del gasto tras UN fallo más (PURO):
 * - `STORAGE` y los `TRANSITORIO` `sinCosto` (pyservices inalcanzable, IA
 *   saturada) solo mueven `ultimoIntento`: la IA no cobró nada y no dicen
 *   nada del comprobante.
 * - Los demás suman un `intento` (la IA pudo cobrar).
 * - Cuentan además «con la IA viva» (`conIa`) los de LECTURA cuando el
 *   fallo mismo lo prueba (`RESPUESTA_IA`: la IA contestó algo inservible)
 *   o cuando la IA le contestó a OTRO gasto después de que éste empezó a
 *   fallar (en su primer fallo: antes, en la MISMA corrida). Un pyservices
 *   caído o colgado no suma `conIa` a nadie: nadie contesta. `ESCRITURA`
 *   nunca suma `conIa` (sellarlo pasaría por el mismo UPDATE que falla).
 */
export function registrarFallo(
  previo: EstadoPostergado | undefined,
  p: {
    fallo: FalloGasto;
    sinCosto: boolean;
    ahora: number;
    inicioCorrida: number;
    /** Epoch ms de la última lectura que la IA contestó (cualquier gasto). */
    ultimaRespuestaIa: number | null;
  },
): EstadoPostergado {
  const base: EstadoPostergado = previo
    ? { ...previo }
    : {
        intentos: 0,
        conIa: 0,
        primerFallo: p.ahora,
        ultimoIntento: p.ahora,
        retirado: false,
      };
  base.ultimoIntento = p.ahora;
  if (p.fallo === 'STORAGE' || p.sinCosto) return base;
  base.intentos += 1;
  if (p.fallo === 'ESCRITURA') return base;
  const desde = previo ? previo.primerFallo : p.inicioCorrida;
  const iaViva =
    p.fallo === 'RESPUESTA_IA' ||
    (p.ultimaRespuestaIa != null && p.ultimaRespuestaIa >= desde);
  if (iaViva) base.conIa += 1;
  return base;
}

/**
 * Qué hacer con el gasto tras registrar su fallo: `SELLAR` como ilegible
 * (falló `FALLOS_CON_IA_PARA_SELLAR` veces con la IA viva; nunca tras un
 * fallo de `ESCRITURA`), `RETIRAR` de la cola de este proceso sin sellar
 * (agotó `INTENTOS_MAX_POR_GASTO` sin esa prueba) o `POSTERGAR` (se
 * reintenta tras `REINTENTO_POSTERGADO_MS`).
 */
export function destinoTrasFallo(
  e: Pick<EstadoPostergado, 'intentos' | 'conIa'>,
  fallo: FalloGasto,
): 'SELLAR' | 'RETIRAR' | 'POSTERGAR' {
  if (fallo !== 'ESCRITURA' && e.conIa >= FALLOS_CON_IA_PARA_SELLAR) {
    return 'SELLAR';
  }
  if (e.intentos >= INTENTOS_MAX_POR_GASTO) return 'RETIRAR';
  return 'POSTERGAR';
}

/** Hojas 2..N de una factura multi-hoja (`valor_ia_extraido.fotos_adicionales`). */
export function fotosAdicionalesDe(valorIa: unknown): string[] {
  if (!valorIa || typeof valorIa !== 'object' || Array.isArray(valorIa)) {
    return [];
  }
  const f = (valorIa as { fotos_adicionales?: unknown }).fotos_adicionales;
  return Array.isArray(f)
    ? f.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}

/** ¿El comprobante se manda como DOCUMENTO (bytes) y no como URL de imagen? */
export function tipoDocumento(path: string): 'PDF' | 'EXCEL' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return 'PDF';
  if (/\.(xlsx|xls|csv)$/.test(lower)) return 'EXCEL';
  return null;
}

/**
 * Archivos (paths de `gasto-fotos`, en orden) que se le mandan a la IA para
 * UN gasto: PDF/Excel solo el documento; imagen, la foto y sus hojas 2..N
 * (`fotos_adicionales`). FUENTE ÚNICA de lo que se lee (`entradaVision`) y
 * de lo que se compara antes de escribir (`mismoComprobante`).
 */
export function archivosDelComprobante(
  fotoUrl: string | null | undefined,
  valorIa: unknown,
): string[] {
  const path = (fotoUrl ?? '').trim();
  if (!path) return [];
  if (tipoDocumento(path)) return [path];
  return [path, ...fotosAdicionalesDe(valorIa).filter((p) => p !== path)];
}

/**
 * ¿El gasto conserva EXACTAMENTE los archivos que se leyeron? Si la foto o
 * sus hojas cambiaron mientras la IA leía (20–40 s), el folio es de la foto
 * VIEJA: no se escribe nada y la foto nueva se lee en otra corrida.
 */
export function mismoComprobante(
  leidos: readonly string[],
  vigentes: readonly string[],
): boolean {
  return (
    leidos.length === vigentes.length &&
    leidos.every((p, i) => p === vigentes[i])
  );
}

/**
 * Qué significa una lectura FALLIDA (`motivo` de `VisionService`, que
 * reenvía el texto de `pyservices/app/services/ia_errores.py` o el `detail`
 * del 422 de `/vision/gasto`):
 * - `RESPUESTA_IA`: la IA SÍ contestó (y cobró) pero la respuesta no sirvió
 *   (truncada por `max_tokens`, sin JSON, JSON inválido, fuera del esquema).
 *   Prueba que pyservices y la IA están vivos: no cuenta para cortar la
 *   corrida y sí para sellar ESE gasto (`registrarFallo`). Se reconoce por
 *   el INICIO del texto (el resto puede traer lo que escribió el modelo).
 * - `IA_NO_DISPONIBLE`: ninguna lectura funcionará (sin saldo, límite de
 *   gasto, llave inválida, modelo inexistente, pyservices sin token) ⇒ no
 *   se sella y la corrida se CORTA ya.
 * - `COMPROBANTE`: ESTE archivo no se puede leer (pesa demasiado, formato no
 *   soportado, foto ilegible, documento largo, Excel viejo o vacío…) y
 *   reintentar no lo arregla ⇒ se sella como ilegible.
 * - `TRANSITORIO`: todo lo demás (pyservices caído, timeout, IA saturada,
 *   «Claude no disponible (…)» genérico) ⇒ no se sella; dos seguidos cortan
 *   la corrida. Un texto que no se reconoce cae AQUÍ (lado seguro: jamás
 *   sella por un error que no entiende a la primera).
 */
export type FalloLecturaFolio =
  | 'IA_NO_DISPONIBLE'
  | 'COMPROBANTE'
  | 'RESPUESTA_IA'
  | 'TRANSITORIO';

/** Inicio del `detail` del 422 de `/vision/gasto` cuando la IA ya contestó. */
const PREFIJOS_RESPUESTA_IA: readonly RegExp[] = [
  /^respuesta truncada/,
  /^respuesta sin json/,
  /^json inválido/,
  /^no se pudo interpretar/,
  /^\d+ validation errors? for /,
];

const MOTIVOS_IA_NO_DISPONIBLE = [
  'sin saldo de créditos',
  'credit balance',
  'límite de gasto de ia',
  'usage limit',
  'llave de la ia no es válida',
  'modelo de ia configurado no existe',
  'internal_shared_token',
  'token interno inválido',
  'pyservices 401',
  'pyservices 403',
  'visión ia deshabilitada',
];

const MOTIVOS_COMPROBANTE = [
  'pesa demasiado',
  'demasiado grande en pixeles',
  'formato de archivo no soportado',
  'no pudo leer la foto',
  'demasiado largo para la ia',
  'demasiadas fotos',
  // 422 de pyservices ANTES de llamar a la IA (`_excel_to_text`).
  'excel viejo',
  'está vacío o no se pudo leer',
];

export function clasificarMotivoLectura(
  motivo: string | null | undefined,
): FalloLecturaFolio {
  const m = (motivo ?? '').trim().toLowerCase();
  if (PREFIJOS_RESPUESTA_IA.some((re) => re.test(m))) return 'RESPUESTA_IA';
  if (MOTIVOS_IA_NO_DISPONIBLE.some((x) => m.includes(x))) {
    return 'IA_NO_DISPONIBLE';
  }
  if (MOTIVOS_COMPROBANTE.some((x) => m.includes(x))) return 'COMPROBANTE';
  return 'TRANSITORIO';
}

/**
 * ¿El fallo TRANSITORIO seguro NO costó créditos? pyservices inalcanzable
 * (red o el 502/503/504 de la orilla de Railway con el servicio abajo) o la
 * IA rechazó por saturación/límite de peticiones antes de leer. Esos no
 * cuentan como intento del gasto (`registrarFallo`): un pyservices caído
 * toda la noche no agota ni sella a nadie. Timeout, 500 y lo desconocido
 * SÍ cuentan (la IA pudo haber leído y cobrado).
 */
export function falloSinCosto(motivo: string | null | undefined): boolean {
  const m = (motivo ?? '').trim().toLowerCase();
  return (
    m.startsWith('sin conexión con pyservices') ||
    /^pyservices 50[234]\b/.test(m) ||
    m.includes('está saturada')
  );
}

/** Lectura tal como la devuelve `VisionService.readGastoTicket`. */
export type LecturaVision =
  | {
      legible?: unknown;
      folio?: unknown;
      monto?: unknown;
      motivo?: unknown;
    }
  | null
  | undefined;

export type ResultadoLecturaFolio =
  | { tipo: 'FOLIO'; folio: string }
  | { tipo: 'SIN_FOLIO' }
  | { tipo: 'ILEGIBLE'; motivo: string | null }
  | {
      tipo: 'FALLO';
      fallo: Exclude<FalloLecturaFolio, 'COMPROBANTE'>;
      motivo: string;
    };

/**
 * Qué se sacó de UNA lectura:
 * - `null` (visión deshabilitada) ⇒ FALLO `IA_NO_DISPONIBLE`. El cron
 *   jamás manda una entrada vacía (la otra causa de `null`): un archivo
 *   vacío se sella como ilegible antes de llamar a la IA.
 * - `RESPUESTA_IA` también es FALLO (no se sella a la primera).
 * - `motivo` sin `monto` (la forma de error de `readGastoTicket`, la misma
 *   que usa `reanalizarConIA`) ⇒ según `clasificarMotivoLectura`.
 * - `legible !== true` ⇒ ILEGIBLE (un folio de una lectura ilegible NO se
 *   guarda, como en `enriquecerGastoConIA`).
 * - Legible ⇒ FOLIO si `folioTicketDeLectura` da algo; si no, SIN_FOLIO.
 */
export function evaluarLecturaFolio(
  lectura: LecturaVision,
): ResultadoLecturaFolio {
  if (!lectura) {
    return {
      tipo: 'FALLO',
      fallo: 'IA_NO_DISPONIBLE',
      motivo:
        'Visión IA deshabilitada (PYSERVICES_BASE_URL/INTERNAL_SHARED_TOKEN)',
    };
  }
  if (lectura.motivo && lectura.monto === undefined) {
    const motivo =
      typeof lectura.motivo === 'string'
        ? lectura.motivo
        : JSON.stringify(lectura.motivo);
    const fallo = clasificarMotivoLectura(motivo);
    if (fallo === 'COMPROBANTE') return { tipo: 'ILEGIBLE', motivo };
    return { tipo: 'FALLO', fallo, motivo };
  }
  if (lectura.legible !== true) return { tipo: 'ILEGIBLE', motivo: null };
  const folio = folioTicketDeLectura(lectura.folio);
  return folio ? { tipo: 'FOLIO', folio } : { tipo: 'SIN_FOLIO' };
}

/**
 * `valor_ia_extraido` con el folio: la lectura PREVIA con su llave `folio`
 * rellenada (la IA solo llena vacíos: desglose, proveedor, matrícula y
 * `fotos_adicionales` de la lectura que la oficina ya revisó NO se tocan).
 * Sin lectura previa (o no es un objeto) se guarda la lectura NUEVA
 * completa (sin `motivo`), con el folio tal como se guardó en
 * `folio_ticket`.
 */
export function lecturaConFolio(
  previa: unknown,
  lectura: Record<string, unknown>,
  folio: string,
): Record<string, unknown> {
  if (previa && typeof previa === 'object' && !Array.isArray(previa)) {
    return { ...(previa as Record<string, unknown>), folio };
  }
  const limpia: Record<string, unknown> = { ...lectura };
  delete limpia.motivo;
  return { ...limpia, folio };
}

/** Línea de `notas` cuando el folio leído ya es de OTRO gasto (⚠ = el
 *  diálogo «Verificar» del panel pinta el aviso ámbar). */
export function lineaFolioDuplicado(folio: string): string {
  return `⚠ IA: folio ${folio} ya existe en otro gasto — revisar`;
}

/** `notas` con `linea` al FINAL (línea nueva), sin repetirla. */
export function notasConLinea(
  notas: string | null | undefined,
  linea: string,
): string {
  const previas = typeof notas === 'string' ? notas.trimEnd() : '';
  if (previas.split('\n').some((l) => l.trim() === linea)) return previas;
  return previas ? `${previas}\n${linea}` : linea;
}

/**
 * ¿El error de Storage dice que el archivo NO EXISTE? (nada que leer ⇒ se
 * sella como ilegible). Cualquier otro error es de red/servicio y se
 * reintenta. Textos reales: `download` ⇒ «Object not found»;
 * `createSignedUrls` por archivo ⇒ «Either the object does not exist or you
 * do not have access to it».
 */
export function esArchivoAusente(mensaje: string | null | undefined): boolean {
  return /object not found|not_found|does not exist/i.test(mensaje ?? '');
}
