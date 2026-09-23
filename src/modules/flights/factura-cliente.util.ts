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
}

/** Fila de `vuelo` (o el trozo que se haya leído) para derivar el estatus. */
export interface VueloFacturaRow {
  facturado?: unknown;
  factura_estatus?: unknown;
  factura_archivo_path?: unknown;
  factura_archivo_nombre?: unknown;
  factura_archivo_subida_at?: unknown;
  factura_archivo_subida_por?: unknown;
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
  };
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

export type ValidacionArchivo =
  | { ok: true; extension: ExtensionArchivoFactura; nombre: string }
  | { ok: false; mensaje: string };

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
    return { ok: false, mensaje: 'El archivo viene sin nombre.' };
  }
  if (a.bytes <= 0) {
    return { ok: false, mensaje: 'El archivo llegó vacío.' };
  }
  if (a.bytes > LIMITE_ARCHIVO_FACTURA_BYTES) {
    return {
      ok: false,
      mensaje: `El archivo pesa ${(a.bytes / 1024 / 1024).toFixed(1)} MB y el máximo son 10 MB.`,
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
