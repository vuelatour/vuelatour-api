/**
 * COMPROBANTE DEL COBRO (24-sep-2026, pedido de Itzi: «si el cliente me
 * manda su comprobante que se pueda adjuntar y que esté ahí mismo en ese
 * apartado de cobros»). Validación PURA del archivo que se adjunta DESPUÉS de
 * registrar el cobro (la app ya subía el voucher al CAPTURAR; el panel no).
 *
 * Reglas: foto (JPG, PNG, WEBP, HEIC/HEIF) o PDF, ≤ 10 MB; la EXTENSIÓN
 * manda y el `content-type` es respaldo. Mismo bucket privado que los
 * vouchers de la app (`cobro-vouchers`), en su propia carpeta de oficina.
 */
import {
  LIMITE_ARCHIVO_FACTURA_BYTES,
  mensajeArchivoMuyGrande,
  nombreArchivoSeguro,
} from './factura-cliente.util';

/** Bucket PRIVADO de los vouchers (el mismo que usa la app). */
export const BUCKET_COBRO_VOUCHERS = 'cobro-vouchers';

/** Tope del comprobante: 10 MB (igual que la factura). */
export const LIMITE_COMPROBANTE_BYTES = LIMITE_ARCHIVO_FACTURA_BYTES;

export const EXTENSIONES_COMPROBANTE = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'heif',
  'pdf',
] as const;
export type ExtensionComprobante = (typeof EXTENSIONES_COMPROBANTE)[number];

const MIME_A_EXTENSION: Record<string, ExtensionComprobante> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

const CONTENT_TYPE: Record<ExtensionComprobante, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

export type ValidacionComprobante =
  | {
      ok: true;
      extension: ExtensionComprobante;
      contentType: string;
      tipo: 'imagen' | 'pdf';
      nombre: string;
    }
  | {
      ok: false;
      codigo: 'ARCHIVO_VACIO' | 'ARCHIVO_MUY_GRANDE' | 'ARCHIVO_TIPO_INVALIDO';
      mensaje: string;
    };

export const MENSAJE_TIPO_COMPROBANTE =
  'El comprobante se sube como foto (JPG, PNG, WEBP, HEIC) o PDF.';

export function validarComprobanteCobro(a: {
  nombre?: string | null;
  mime?: string | null;
  bytes: number;
}): ValidacionComprobante {
  if (a.bytes <= 0) {
    return {
      ok: false,
      codigo: 'ARCHIVO_VACIO',
      mensaje: 'El archivo llegó vacío.',
    };
  }
  if (a.bytes > LIMITE_COMPROBANTE_BYTES) {
    return {
      ok: false,
      codigo: 'ARCHIVO_MUY_GRANDE',
      mensaje: mensajeArchivoMuyGrande(a.bytes),
    };
  }
  const nombre = nombreArchivoSeguro((a.nombre ?? '').trim()) || 'comprobante';
  const partes = nombre.split('.');
  const ext = partes.length > 1 ? (partes.at(-1) ?? '').toLowerCase() : '';
  const porExtension = (EXTENSIONES_COMPROBANTE as readonly string[]).includes(
    ext,
  )
    ? (ext as ExtensionComprobante)
    : null;
  const porMime =
    MIME_A_EXTENSION[(a.mime ?? '').toLowerCase().split(';')[0].trim()] ?? null;
  const extension = porExtension ?? porMime;
  if (!extension) {
    return {
      ok: false,
      codigo: 'ARCHIVO_TIPO_INVALIDO',
      mensaje: MENSAJE_TIPO_COMPROBANTE,
    };
  }
  return {
    ok: true,
    extension,
    contentType: CONTENT_TYPE[extension],
    tipo: extension === 'pdf' ? 'pdf' : 'imagen',
    nombre,
  };
}

/** `oficina/<vuelo>/<cobro>/<uuid>.<ext>` dentro de `cobro-vouchers`. */
export function pathComprobanteCobro(
  vueloId: string,
  cobroId: string,
  id: string,
  extension: ExtensionComprobante,
): string {
  return `oficina/${vueloId}/${cobroId}/${id}.${extension}`;
}

/** ¿Imagen o PDF? (por la extensión del path guardado). */
export function tipoComprobantePath(path: string): 'imagen' | 'pdf' {
  return /\.pdf$/i.test(path) ? 'pdf' : 'imagen';
}
