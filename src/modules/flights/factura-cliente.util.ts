/**
 * FACTURA DEL SERVICIO **POR VUELO** (22-sep-2026, palabras del cliente:
 * «quisiera agregar por cada vuelo las opciones para identificar vuelos
 * facturado, sin factura, factura elaborada y enviada, y que pueda yo
 * también subir la factura del servicio a un lado»).
 *
 * FUENTE ÚNICA de la derivación del estatus y de la validación del archivo.
 * PURO (sin Nest ni Supabase) para que el mismo contrato lo usen el bloque
 * del snapshot, el del listado y el PATCH — y para que el panel lo copie
 * palabra por palabra.
 *
 * DOS COSAS DISTINTAS QUE NO HAY QUE CONFUNDIR:
 *  - `vuelo.facturado` (boolean) = **CFDI TIMBRADO POR EL SISTEMA**. Es el
 *    candado de emisión (`invoices.service.emitir` lo pone con un
 *    compare-and-set; la cancelación ante el SAT lo libera).
 *  - `vuelo.factura_estatus` = **seguimiento administrativo** de la oficina,
 *    con el estado intermedio que hoy llevan a mano: «elaborada y enviada».
 *
 * REGLA DE DERIVACIÓN (monótona, y por eso segura con un API viejo o con la
 * migración `20260923000001` todavía sin aplicar): un CFDI timbrado MANDA
 * (`facturado = true` ⇒ FACTURADO, aunque la columna no exista todavía);
 * si no hay CFDI vivo, vale lo que diga la columna; sin columna, SIN_FACTURA.
 * Cancelar el CFDI NO baja el estatus solo: la factura se elaboró y se
 * envió — que alguien lo decida a mano.
 */

export const ESTATUS_FACTURA_CLIENTE = [
  'SIN_FACTURA',
  'ELABORADA_ENVIADA',
  'FACTURADO',
] as const;

export type EstatusFacturaCliente = (typeof ESTATUS_FACTURA_CLIENTE)[number];

/** Etiquetas es-MX; el panel copia ESTA tabla (paridad panel⇄API). */
export const ETIQUETAS_FACTURA_CLIENTE: Record<EstatusFacturaCliente, string> =
  {
    SIN_FACTURA: 'Sin factura',
    ELABORADA_ENVIADA: 'Factura elaborada y enviada',
    FACTURADO: 'Facturado',
  };

/** Tope del archivo de la factura del servicio: 10 MB. */
export const LIMITE_ARCHIVO_FACTURA_BYTES = 10 * 1024 * 1024;

/**
 * Tope de MULTER para la ruta de subida (24-sep-2026): 1 MB por ENCIMA del
 * de negocio. Con el tope exacto, multer cortaba la petición antes de que
 * `validarArchivoFactura` pudiera decir cuánto pesaba el archivo; con el
 * margen, un PDF de 10.4 MB llega a la validación y el 413 dice «El archivo
 * pesa 10.4 MB y el máximo son 10 MB». Arriba de 11 MB responde multer (413
 * con el peso APROXIMADO que da el Content-Length — `all-exceptions.filter`).
 */
export const LIMITE_MULTER_FACTURA_BYTES =
  LIMITE_ARCHIVO_FACTURA_BYTES + 1024 * 1024;

/** «El archivo pesa 12.3 MB y el máximo son 10 MB.» (fuente única). */
export function mensajeArchivoMuyGrande(bytes: number): string {
  return `El archivo pesa ${(bytes / 1024 / 1024).toFixed(1)} MB y el máximo son 10 MB.`;
}

/** Extensiones aceptadas: el CFDI (XML) y el papel que se enseña (PDF). */
export const EXTENSIONES_ARCHIVO_FACTURA = ['pdf', 'xml'] as const;
export type ExtensionArchivoFactura =
  (typeof EXTENSIONES_ARCHIVO_FACTURA)[number];

export interface ArchivoFacturaCliente {
  path: string;
  nombre: string | null;
  subida_at: string | null;
  subida_por_nombre: string | null;
}

export interface BloqueFacturaCliente {
  estatus: EstatusFacturaCliente;
  archivo: ArchivoFacturaCliente | null;
  /**
   * FOLIO de la factura del servicio (24-sep-2026, ADITIVO): el que tecleó
   * la oficina o el que se sacó del XML del CFDI (`SERIE-FOLIO`). `null` =
   * nadie lo ha capturado (o la migración `20260924000001` no está aplicada).
   */
  folio: string | null;
  /** UUID fiscal (folio fiscal del SAT) si se subió el XML timbrado. */
  uuid: string | null;
}

/** Fila de `vuelo` (o el trozo que se haya leído) para derivar el estatus. */
export interface VueloFacturaRow {
  facturado?: unknown;
  factura_estatus?: unknown;
  factura_archivo_path?: unknown;
  factura_archivo_nombre?: unknown;
  factura_archivo_subida_at?: unknown;
  factura_archivo_subida_por?: unknown;
  /** Migración `20260924000001` (24-sep-2026). */
  factura_folio?: unknown;
  factura_uuid?: unknown;
}

export function esEstatusFacturaCliente(
  x: unknown,
): x is EstatusFacturaCliente {
  return (
    typeof x === 'string' &&
    (ESTATUS_FACTURA_CLIENTE as readonly string[]).includes(x)
  );
}

/**
 * Estatus EFECTIVO de la factura del servicio. Ver la regla de derivación
 * arriba: el CFDI timbrado manda; sin él, la columna; sin columna,
 * SIN_FACTURA.
 */
export function estatusFacturaCliente(
  vuelo: VueloFacturaRow | null | undefined,
): EstatusFacturaCliente {
  if (!vuelo) return 'SIN_FACTURA';
  if (vuelo.facturado === true) return 'FACTURADO';
  return esEstatusFacturaCliente(vuelo.factura_estatus)
    ? vuelo.factura_estatus
    : 'SIN_FACTURA';
}

/**
 * Bloque ADITIVO `factura_cliente` que viaja en el snapshot y en el listado.
 * `subidaPorNombre` se resuelve aparte (una consulta a `usuario` por lote).
 */
export function bloqueFacturaCliente(
  vuelo: VueloFacturaRow | null | undefined,
  subidaPorNombre?: string | null,
): BloqueFacturaCliente {
  const path =
    typeof vuelo?.factura_archivo_path === 'string' &&
    vuelo.factura_archivo_path.trim() !== ''
      ? vuelo.factura_archivo_path
      : null;
  return {
    estatus: estatusFacturaCliente(vuelo),
    archivo: path
      ? {
          path,
          nombre:
            typeof vuelo?.factura_archivo_nombre === 'string'
              ? vuelo.factura_archivo_nombre
              : null,
          subida_at:
            typeof vuelo?.factura_archivo_subida_at === 'string'
              ? vuelo.factura_archivo_subida_at
              : null,
          subida_por_nombre: subidaPorNombre ?? null,
        }
      : null,
    folio: normalizarFolioFactura(vuelo?.factura_folio),
    uuid: normalizarUuidFiscal(vuelo?.factura_uuid),
  };
}

// ===================== FOLIO de la factura (24-sep-2026) =====================
//
// Palabras del cliente: «subí la factura de un vuelo, peroooo al momento de
// descargar el reporte en Excel sí aparece la columna de factura (del vuelo)
// pero no aparece el folio de la factura que subí en el registro». La columna
// «FACTURA VUELATOUR» del Libro Dinero y «factura vuelatour» del balance solo
// leían la tabla `factura` (CFDI timbrado por el PAC: 0 filas en prod) — la
// factura que la oficina sube a mano no guardaba folio en ningún lado.

/** Tope del folio tecleado (y del extraído del XML). */
export const LIMITE_FOLIO_FACTURA = 40;

/**
 * Folio saneado: sin espacios de sobra ni caracteres de control, ≤ 40.
 * `null` = vacío o no es texto (así se BORRA el folio desde el PATCH).
 * NO cambia mayúsculas: el folio se guarda como lo escribió quien factura.
 */
export function normalizarFolioFactura(x: unknown): string | null {
  if (typeof x !== 'string' && typeof x !== 'number') return null;
  const limpio = String(x)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio) return null;
  return limpio.slice(0, LIMITE_FOLIO_FACTURA).trim();
}

const RE_UUID_FISCAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID fiscal en MAYÚSCULAS (como lo imprime el SAT) o `null`. */
export function normalizarUuidFiscal(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const u = x.trim();
  return RE_UUID_FISCAL.test(u) ? u.toUpperCase() : null;
}

/**
 * Etiqueta `SERIE-FOLIO` — la MISMA regla que el Excel ya usaba para el CFDI
 * del PAC (`[serie, folio].filter(Boolean).join('-')`). `null` si no hay
 * ninguno de los dos.
 */
export function etiquetaSerieFolio(
  serie: unknown,
  folio: unknown,
): string | null {
  const partes = [serie, folio]
    .map((p) =>
      typeof p === 'string' || typeof p === 'number' ? String(p).trim() : '',
    )
    .filter(Boolean);
  return partes.length > 0 ? partes.join('-') : null;
}

export interface DatosCfdi {
  serie: string | null;
  folio: string | null;
  /** Lo que se guarda como folio: `SERIE-FOLIO`, o solo el Folio. */
  etiqueta: string | null;
  uuid: string | null;
}

/** Decodifica las entidades XML de un valor de atributo. */
function decodificarEntidadesXml(v: string): string {
  return v.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,
    (m, ent: string) => {
      const e = ent.toLowerCase();
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      const code = e.startsWith('#x')
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    },
  );
}

/** Atributos de la PRIMERA etiqueta de apertura `<prefijo:Nombre …>`. */
function atributosDeNodo(
  xml: string,
  nombre: string,
): Map<string, string> | null {
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${nombre}\\b([^>]*)>`);
  const m = re.exec(xml);
  if (!m) return null;
  const attrs = new Map<string, string>();
  const reAttr = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let a: RegExpExecArray | null;
  while ((a = reAttr.exec(m[1])) !== null) {
    attrs.set(a[1], decodificarEntidadesXml(a[2] ?? a[3] ?? ''));
  }
  return attrs;
}

/** Texto de un XML en bytes: UTF-8 (con o sin BOM) o UTF-16 con BOM. */
export function textoDeXml(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const le = Buffer.from(buffer.subarray(2));
    le.swap16();
    return le.toString('utf16le');
  }
  const t = buffer.toString('utf8');
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/**
 * Serie, Folio y UUID de un CFDI (3.3 / 4.0; tolera el 3.2 con atributos en
 * minúscula). Parser TOLERANTE a propósito (regex sobre la etiqueta de
 * apertura, sin dependencias): un XML raro o que no es CFDI devuelve `null`
 * y la subida sigue — el folio es una ayuda, nunca un requisito.
 *
 *  - `cfdi:Comprobante` → `Serie` + `Folio` ⇒ etiqueta `SERIE-FOLIO` (o solo
 *    el Folio). Sin Folio no hay etiqueta: la Serie sola no identifica nada.
 *    Si `SERIE-FOLIO` pasa de 40 caracteres queda solo el Folio (el SAT lo
 *    limita a 40).
 *  - `tfd:TimbreFiscalDigital` → `UUID` (el folio fiscal), en mayúsculas.
 */
export function extraerDatosCfdi(xml: string | Buffer): DatosCfdi | null {
  const texto = typeof xml === 'string' ? xml : textoDeXml(xml);
  const comp = atributosDeNodo(texto, 'Comprobante');
  if (!comp) return null;
  const leer = (k: string) =>
    normalizarFolioFactura(comp.get(k) ?? comp.get(k.toLowerCase()));
  const serie = leer('Serie');
  const folio = leer('Folio');
  const tfd = atributosDeNodo(texto, 'TimbreFiscalDigital');
  const uuid = normalizarUuidFiscal(tfd?.get('UUID') ?? tfd?.get('uuid'));
  let etiqueta: string | null = null;
  if (folio) {
    const completa = etiquetaSerieFolio(serie, folio);
    etiqueta =
      completa && completa.length <= LIMITE_FOLIO_FACTURA ? completa : folio;
  }
  return { serie, folio, etiqueta, uuid };
}

// ============ CFDI COMPLETO (registro de facturas emitidas, 24-sep-2026) ============
//
// «Facturas emitidas» (pedido de Ale): Mari suelta el XML (y/o el PDF) y el
// formulario se llena solo. `extraerDatosCfdi` (arriba) se queda INTACTO —
// lo usa la subida legada por vuelo—; esto AGREGA lo que el registro
// necesita: tipo, fecha, emisor, receptor, totales, moneda y método.

/**
 * ¿El XML declara DOCTYPE o ENTITY? Se RECHAZA antes de leer (422
 * `XML_NO_PERMITIDO`). La lectura de aquí es por regex y no expande nada,
 * pero es la misma defensa que pyservices (XXE / «billion laughs»): un CFDI
 * legítimo del SAT nunca trae DOCTYPE. Solo se miran los primeros 4096
 * caracteres (el prólogo).
 */
export function xmlDeclaraDoctype(buf: Buffer | string): boolean {
  const texto = typeof buf === 'string' ? buf : textoDeXml(buf);
  return /<!\s*(DOCTYPE|ENTITY)/i.test(texto.slice(0, 4096));
}

export interface CfdiCompleto extends DatosCfdi {
  /** Comprobante@TipoDeComprobante ('I', 'E', 'P', 'T', 'N'; el 3.2 «ingreso» ⇒ 'I'). */
  tipo_comprobante: string | null;
  /** Comprobante@Fecha → 'YYYY-MM-DD' (fecha de pared, sin conversión TZ). */
  fecha_emision: string | null;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  subtotal: number | null;
  total: number | null;
  /** @TotalImpuestosTrasladados del nodo Impuestos que LO TRAE (el del comprobante). */
  iva: number | null;
  /** @Moneda tal cual. */
  moneda_raw: string | null;
  /** 'MXN' | 'USD' | null (MXN/XXX ⇒ 'MXN'; otra ⇒ null). */
  moneda: 'MXN' | 'USD' | null;
  metodo_pago: 'PUE' | 'PPD' | null;
  /** 2 dígitos del catálogo del SAT o null. */
  forma_pago: string | null;
}

/** Atributo sin importar mayúsculas (el 3.2 usa `subTotal`, `rfc`, `fecha`…). */
function leerAtributo(
  attrs: Map<string, string> | null,
  nombre: string,
): string | null {
  if (!attrs) return null;
  const directo = attrs.get(nombre);
  if (directo != null) return directo.trim() || null;
  const buscado = nombre.toLowerCase();
  for (const [k, v] of attrs) {
    // Sin prefijo de namespace (p. ej. `xsi:…` no cuenta).
    if (!k.includes(':') && k.toLowerCase() === buscado) {
      return v.trim() || null;
    }
  }
  return null;
}

function numeroCfdi(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** RFC en mayúsculas sin espacios ni guiones (o null). */
export function normalizarRfc(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const r = v.toUpperCase().replace(/[\s-]+/g, '');
  return r || null;
}

/** 'MXN' | 'USD' | null — XXX (sin moneda, CFDI de pago) y «MN» se leen como MXN. */
export function monedaCfdi(v: string | null | undefined): 'MXN' | 'USD' | null {
  const m = (v ?? '').trim().toUpperCase();
  if (m === 'MXN' || m === 'XXX' || m === 'MN') return 'MXN';
  if (m === 'USD') return 'USD';
  return null;
}

function tipoComprobanteCfdi(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  const palabras: Record<string, string> = {
    ingreso: 'I',
    egreso: 'E',
    traslado: 'T',
    pago: 'P',
    nomina: 'N',
    nómina: 'N',
  };
  return palabras[t.toLowerCase()] ?? t.toUpperCase();
}

/**
 * CFDI completo (3.3 / 4.0; tolera el 3.2 con atributos en minúscula, BOM,
 * UTF-16 y entidades — mismo parser tolerante que `extraerDatosCfdi`).
 * `null` = no es un CFDI legible (no hay `Comprobante`).
 */
export function extraerCfdiCompleto(xml: string | Buffer): CfdiCompleto | null {
  const texto = typeof xml === 'string' ? xml : textoDeXml(xml);
  const base = extraerDatosCfdi(texto);
  if (!base) return null;
  const comp = atributosDeNodo(texto, 'Comprobante');
  const emisor = atributosDeNodo(texto, 'Emisor');
  const receptor = atributosDeNodo(texto, 'Receptor');

  // IVA: el nodo `Impuestos` que TRAE TotalImpuestosTrasladados es el del
  // comprobante; los `Impuestos` de cada concepto no lo tienen.
  let iva: number | null = null;
  const reImp = /<(?:[A-Za-z_][\w.-]*:)?Impuestos\b([^>]*)>/g;
  let mImp: RegExpExecArray | null;
  while ((mImp = reImp.exec(texto)) !== null) {
    const attrs = new Map<string, string>();
    const reAttr = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = reAttr.exec(mImp[1])) !== null) {
      attrs.set(a[1], decodificarEntidadesXml(a[2] ?? a[3] ?? ''));
    }
    const t = numeroCfdi(leerAtributo(attrs, 'TotalImpuestosTrasladados'));
    if (t != null) {
      iva = t;
      break;
    }
  }

  const fechaRaw = leerAtributo(comp, 'Fecha');
  const fecha =
    fechaRaw && /^\d{4}-\d{2}-\d{2}/.test(fechaRaw)
      ? fechaRaw.slice(0, 10)
      : null;
  const monedaRaw = leerAtributo(comp, 'Moneda');
  const metodo = (leerAtributo(comp, 'MetodoPago') ?? '').toUpperCase();
  const forma = leerAtributo(comp, 'FormaPago');
  const nombre = (v: string | null) =>
    v ? v.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
  return {
    ...base,
    tipo_comprobante: tipoComprobanteCfdi(
      leerAtributo(comp, 'TipoDeComprobante'),
    ),
    fecha_emision: fecha,
    emisor_rfc: normalizarRfc(leerAtributo(emisor, 'Rfc')),
    emisor_nombre: nombre(leerAtributo(emisor, 'Nombre')),
    receptor_rfc: normalizarRfc(leerAtributo(receptor, 'Rfc')),
    receptor_nombre: nombre(leerAtributo(receptor, 'Nombre')),
    subtotal: numeroCfdi(leerAtributo(comp, 'SubTotal')),
    total: numeroCfdi(leerAtributo(comp, 'Total')),
    iva,
    moneda_raw: monedaRaw,
    moneda: monedaCfdi(monedaRaw),
    metodo_pago: metodo === 'PUE' || metodo === 'PPD' ? metodo : null,
    forma_pago: forma && /^\d{2}$/.test(forma) ? forma : null,
  };
}

/** Fila de `factura_emitida` (vía el puente) que alimenta la cascada del Excel. */
export interface FacturaEmitidaEtiquetaRow {
  serie?: unknown;
  folio?: unknown;
  folio_num?: unknown;
  estatus?: unknown;
  deleted_at?: unknown;
}

/**
 * Etiquetas de las facturas EMITIDAS a mano VIGENTES (no borradas) de un
 * vuelo, ordenadas por serie → número → folio y unidas con ", "
 * («A-123, A-130»). `null` si no hay ninguna. PURA (la cascada del Excel).
 */
export function etiquetaEmitidasVigentes(
  filas: ReadonlyArray<FacturaEmitidaEtiquetaRow>,
): string | null {
  const vivas = filas.filter(
    (f) =>
      f.estatus === 'VIGENTE' && (f.deleted_at == null || f.deleted_at === ''),
  );
  if (vivas.length === 0) return null;
  const txt = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const ordenadas = [...vivas].sort((a, b) => {
    const sa = txt(a.serie).toUpperCase();
    const sb = txt(b.serie).toUpperCase();
    if (sa !== sb) return sa < sb ? -1 : 1;
    const na = num(a.folio_num);
    const nb = num(b.folio_num);
    if (na !== nb) {
      if (na == null) return 1;
      if (nb == null) return -1;
      return na - nb;
    }
    const fa = txt(a.folio).toUpperCase();
    const fb = txt(b.folio).toUpperCase();
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  const etiquetas = ordenadas
    .map((f) => etiquetaSerieFolio(f.serie, f.folio))
    .filter((e): e is string => !!e);
  return etiquetas.length > 0 ? [...new Set(etiquetas)].join(', ') : null;
}

/**
 * Lo que dice la columna «FACTURA VUELATOUR» del Libro Dinero y «factura
 * vuelatour» del balance — FUENTE ÚNICA (24-sep-2026). Cascada:
 *  1. CFDI timbrado VIVO por el sistema (`serie-folio` de la tabla `factura`,
 *     no cancelado) — manda, es el documento fiscal;
 *  2. las facturas EMITIDAS a mano VIGENTES del registro (`factura_emitida`
 *     vía el puente, «A-123, A-130»; `etiquetaEmitidasVigentes`) — parámetro
 *     OPCIONAL `emitidas` (24-sep-2026, migración 20260924000003);
 *  3. el folio de la factura del servicio (`vuelo.factura_folio`: tecleado
 *     por la oficina o sacado del XML que subió — LEGADO);
 *  4. sin folio pero con seguimiento (`factura_estatus` ≠ SIN_FACTURA): la
 *     etiqueta del estatus («Facturado» / «Factura elaborada y enviada») —
 *     el Excel ya no dice «nada» de un vuelo que la oficina marcó facturado;
 *  5. vacío (`null`).
 */
export function etiquetaFacturaVuelo(p: {
  cfdi?: string | null;
  emitidas?: string | null;
  vuelo?: VueloFacturaRow | null;
}): string | null {
  const cfdi = typeof p.cfdi === 'string' ? p.cfdi.trim() : '';
  if (cfdi) return cfdi;
  const emitidas = typeof p.emitidas === 'string' ? p.emitidas.trim() : '';
  if (emitidas) return emitidas;
  const folio = normalizarFolioFactura(p.vuelo?.factura_folio);
  if (folio) return folio;
  const estatus = estatusFacturaCliente(p.vuelo);
  return estatus === 'SIN_FACTURA' ? null : ETIQUETAS_FACTURA_CLIENTE[estatus];
}

/**
 * Etiqueta del CFDI VIVO de un vuelo entre sus filas de `factura`: la
 * primera NO cancelada con serie/folio (misma regla que el Excel usaba).
 */
export function etiquetaCfdiVivo(
  facturas: Array<{ serie?: unknown; folio?: unknown; estado?: unknown }>,
): string | null {
  for (const f of facturas) {
    if (f.estado === 'CANCELADA') continue;
    const e = etiquetaSerieFolio(f.serie, f.folio);
    if (e) return e;
  }
  return null;
}

/**
 * ¿El CFDI timbrado impide bajar el estatus? Con `facturado = true` el vuelo
 * YA tiene una factura fiscal viva: dejar que el panel lo regrese a «sin
 * factura» sería mentirle a la contabilidad. Se cancela el CFDI primero.
 */
export function bloqueaBajarEstatus(
  vuelo: VueloFacturaRow | null | undefined,
  destino: EstatusFacturaCliente,
): boolean {
  return vuelo?.facturado === true && destino !== 'FACTURADO';
}

export const MENSAJE_VUELO_CON_CFDI =
  'Este vuelo ya tiene un CFDI timbrado: su factura no puede regresar a ' +
  '«sin factura» ni a «elaborada y enviada». Cancela el CFDI ante el SAT ' +
  'si la factura no procede.';

/**
 * Motivo de rechazo del archivo (24-sep-2026, ADITIVO): el servicio responde
 * **413** para `ARCHIVO_MUY_GRANDE` (lo que HTTP dice que es) y 400 para el
 * resto, con este código en `error` para que el panel no tenga que adivinar
 * por el texto.
 */
export type CodigoArchivoInvalido =
  | 'ARCHIVO_SIN_NOMBRE'
  | 'ARCHIVO_VACIO'
  | 'ARCHIVO_MUY_GRANDE'
  | 'ARCHIVO_TIPO_INVALIDO';

export type ValidacionArchivo =
  | { ok: true; extension: ExtensionArchivoFactura; nombre: string }
  | { ok: false; mensaje: string; codigo: CodigoArchivoInvalido };

/** Nombre "de archivo" sano: sin rutas, sin caracteres raros, ≤ 120 chars. */
export function nombreArchivoSeguro(nombre: string): string {
  const base = nombre.split(/[\\/]/).at(-1) ?? nombre;
  return base.replace(/[^\w.\- ]+/g, '_').slice(-120);
}

/**
 * Valida el archivo de la factura del servicio: PDF o XML, ≤ 10 MB y con
 * nombre. La extensión gana sobre el `content-type` (los navegadores mandan
 * `application/octet-stream` para el XML más veces de las que se cree).
 */
export function validarArchivoFactura(a: {
  nombre?: string | null;
  mime?: string | null;
  bytes: number;
}): ValidacionArchivo {
  const nombre = nombreArchivoSeguro((a.nombre ?? '').trim());
  if (!nombre) {
    return {
      ok: false,
      mensaje: 'El archivo viene sin nombre.',
      codigo: 'ARCHIVO_SIN_NOMBRE',
    };
  }
  if (a.bytes <= 0) {
    return {
      ok: false,
      mensaje: 'El archivo llegó vacío.',
      codigo: 'ARCHIVO_VACIO',
    };
  }
  if (a.bytes > LIMITE_ARCHIVO_FACTURA_BYTES) {
    return {
      ok: false,
      mensaje: mensajeArchivoMuyGrande(a.bytes),
      codigo: 'ARCHIVO_MUY_GRANDE',
    };
  }
  const ext = (nombre.split('.').at(-1) ?? '').toLowerCase();
  const mime = (a.mime ?? '').toLowerCase();
  const porExtension = (
    EXTENSIONES_ARCHIVO_FACTURA as readonly string[]
  ).includes(ext)
    ? (ext as ExtensionArchivoFactura)
    : null;
  const porMime = mime.includes('pdf')
    ? 'pdf'
    : mime.includes('xml')
      ? 'xml'
      : null;
  const extension = porExtension ?? porMime;
  if (!extension) {
    return {
      ok: false,
      mensaje:
        'La factura se sube en PDF o en XML (el CFDI). Ese archivo no es ninguno de los dos.',
      codigo: 'ARCHIVO_TIPO_INVALIDO',
    };
  }
  return { ok: true, extension, nombre };
}

/** Archivo ya normalizado que recibe el servicio. */
export interface ArchivoEntrante {
  buffer: Buffer;
  nombre?: string | null;
  mime?: string | null;
}

/**
 * Archivo de `multipart/form-data` (multer). Se tipa aquí porque el repo no
 * instala `@types/multer`: solo se usan estos cuatro campos.
 */
export interface ArchivoMultipart {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
  size?: number;
}

export const MENSAJE_SIN_ARCHIVO =
  'No llegó ningún archivo. Mándalo como multipart/form-data en el campo ' +
  '«file», o en JSON como { file_base64, filename }.';

/**
 * Normaliza las DOS formas de subir el archivo: `multipart/form-data` (campo
 * `file`, lo que usa el panel) y JSON base64 (el patrón del resto del repo:
 * foto del gasto, XML de factura recibida, estado de cuenta). `null` = no
 * vino ninguna de las dos.
 */
export function archivoDeLaPeticion(
  file?: ArchivoMultipart | null,
  cuerpo?: {
    file_base64?: string | null;
    filename?: string | null;
    content_type?: string | null;
  } | null,
): ArchivoEntrante | null {
  if (file?.buffer && file.buffer.length > 0) {
    return {
      buffer: file.buffer,
      nombre: file.originalname ?? null,
      mime: file.mimetype ?? null,
    };
  }
  const b64 = (cuerpo?.file_base64 ?? '').trim();
  if (!b64) return null;
  return {
    buffer: Buffer.from(b64, 'base64'),
    nombre: cuerpo?.filename ?? null,
    mime: cuerpo?.content_type ?? null,
  };
}

/** `content-type` con el que se guarda en Storage. */
export function contentTypeArchivoFactura(
  extension: ExtensionArchivoFactura,
): string {
  return extension === 'pdf' ? 'application/pdf' : 'application/xml';
}

/**
 * Path dentro del bucket PRIVADO `facturas`. Un archivo por intento con id
 * propio: reemplazar la factura NUNCA pisa el archivo anterior a medias (se
 * borra explícitamente después de guardar el path nuevo).
 */
export function pathArchivoFactura(
  vueloId: string,
  id: string,
  extension: ExtensionArchivoFactura,
): string {
  return `vuelos/${vueloId}/${id}.${extension}`;
}
