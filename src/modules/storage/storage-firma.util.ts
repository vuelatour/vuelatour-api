/**
 * Firma GENÉRICA y ACOTADA de archivos de Storage (1-oct-2026, API 0.0.48)
 * para `POST /v1/storage/firmar`. Helper PURO (con spec): lista blanca de
 * buckets, roles por bucket, tope de paths y validación de cada path.
 *
 * Para qué existe: el panel firma las miniaturas al renderizar la página y la
 * oficina deja la pestaña abierta horas; cuando la firma vence, Supabase
 * responde 400 `InvalidJWT` y la foto sale rota («las fotos de las facturas
 * no están cargando»). El componente del visor ahora pide una URL NUEVA del
 * MISMO archivo al fallar (o al abrir el visor con una URL vieja) por este
 * endpoint, sin recargar la página y sin pasar los bytes por Vercel.
 *
 * Reglas:
 *  - SOLO buckets de `BUCKETS_FIRMABLES`. Un bucket desconocido es 400
 *    `BUCKET_NO_PERMITIDO`: el endpoint firma con la service key, así que
 *    abrirlo a cualquier bucket expondría, p. ej., `csd` (los certificados
 *    de sello digital del SAT) o los que se agreguen después sin pensarlo.
 *  - Roles POR BUCKET (`ROLES_POR_BUCKET`), default-deny: este endpoint
 *    NUNCA firma a un rol más de lo que ya le daban los endpoints
 *    específicos de ese bucket o la política de lectura de Storage (revisión
 *    adversarial 1-oct-2026: con «oficina firma todo», ANALISTA y SOCIO
 *    sacaban estados de cuenta, CFDI e ingresos que sus endpoints les
 *    niegan, y COORDINADOR estados de cuenta). Los buckets que Storage ya
 *    deja leer a cualquier autenticado (gasto-fotos, taco-fotos, planes-vuelo,
 *    cobro-vouchers) o que son públicos (inventario-fotos) no abren nada
 *    nuevo; los privados de verdad (facturas, estados-cuenta, ingresos,
 *    documentos-flota) copian los `@Roles` de su endpoint. PILOTO/MECANICO
 *    solo `BUCKETS_TRIPULACION` (gasto-fotos, taco-fotos). Rol fuera ⇒ 403
 *    `BUCKET_FUERA_DE_ROL`. VISITANTE ni llega (RolesGuard).
 *  - Máximo `MAX_PATHS_FIRMA` paths por solicitud (`DEMASIADOS_PATHS`).
 *  - Cada path es la llave DENTRO del bucket tal como se guarda en la BD
 *    (`foto_url`, `foto_taco_*_url`, `foto_voucher_url`…): sin `/` inicial,
 *    sin segmentos `.`/`..`, sin `\`, sin caracteres de control y nunca una
 *    URL completa (`PATH_INVALIDO`). supabase-js manda los paths en el
 *    CUERPO de la firma por lote, pero un `..` es defensa en profundidad
 *    barata contra cualquier normalización de ruta futura.
 */
import { Rol } from '../../common/types/auth.types';

/** Buckets que el panel puede volver a firmar (el resto ⇒ 400). */
export const BUCKETS_FIRMABLES = [
  'gasto-fotos',
  'taco-fotos',
  'cobro-vouchers',
  'planes-vuelo',
  'facturas',
  'estados-cuenta',
  'documentos-flota',
  'ingresos',
  'inventario-fotos',
  // Pagos de utilidades a socios (1-oct-2026, API 0.0.49): comprobantes.
  'reparto-comprobantes',
] as const;

export type BucketFirmable = (typeof BUCKETS_FIRMABLES)[number];

/** Lo único que PILOTO/MECANICO pueden firmar. */
export const BUCKETS_TRIPULACION: readonly BucketFirmable[] = [
  'gasto-fotos',
  'taco-fotos',
];

/** Roles de oficina (los que ven el panel). */
export const ROLES_OFICINA_FIRMA: readonly Rol[] = [
  Rol.ADMIN,
  Rol.COORDINADOR,
  Rol.FACTURACION,
  Rol.SOCIO,
  Rol.ANALISTA,
];

/** Tripulación: solo `BUCKETS_TRIPULACION`. */
export const ROLES_TRIPULACION_FIRMA: readonly Rol[] = [
  Rol.PILOTO,
  Rol.MECANICO,
];

/**
 * Quién firma cada bucket — NUNCA más que el endpoint específico del bucket
 * o la política de lectura de Storage. Al agregar un bucket a la lista
 * blanca hay que darle aquí sus roles (el tipo lo exige).
 */
export const ROLES_POR_BUCKET: Readonly<
  Record<BucketFirmable, readonly Rol[]>
> = {
  // Storage: lectura para cualquier autenticado (`*_read_own`).
  'gasto-fotos': [...ROLES_OFICINA_FIRMA, ...ROLES_TRIPULACION_FIRMA],
  'taco-fotos': [...ROLES_OFICINA_FIRMA, ...ROLES_TRIPULACION_FIRMA],
  // Storage: lectura autenticada; `GET flights/:id/plan-vuelo-url` lo da a
  // todo rol con acceso al vuelo, pero el PILOTO solo a SUS vuelos
  // (assertAccess) — aquí no hay vuelo que verificar ⇒ solo oficina.
  'planes-vuelo': ROLES_OFICINA_FIRMA,
  // Bucket PÚBLICO.
  'inventario-fotos': ROLES_OFICINA_FIRMA,
  // = `POST flights/cobro-voucher-urls` (el panel le dice al SOCIO «Solo
  // oficina abre el comprobante»).
  'cobro-vouchers': [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION],
  // Privados SIN política de lectura: copian el `@Roles` de su endpoint.
  // facturas = factura-cliente/facturas-emitidas `archivo-url`.
  facturas: [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION],
  // ingresos = `ROLES_INGRESOS` (`GET ingresos/:id/archivo-url`).
  ingresos: [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION],
  // documentos-flota = `GET expirations/:id/archivo` y la póliza.
  'documentos-flota': [Rol.ADMIN, Rol.COORDINADOR],
  // estados-cuenta = controller de conciliación.
  'estados-cuenta': [Rol.ADMIN, Rol.FACTURACION],
  // reparto-comprobantes = `GET profit-sharing/pagos`
  // (`ROLES_PAGOS_SOCIOS_LECTURA`): el SOCIO ve el comprobante de SUS pagos
  // (el listado solo le entrega sus renglones y sus paths).
  'reparto-comprobantes': [Rol.ADMIN, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO],
};

/** Todos los roles que llegan al endpoint (para `@Roles`). */
export const ROLES_FIRMA: readonly Rol[] = [
  ...new Set(Object.values(ROLES_POR_BUCKET).flat()),
];

/** Tope de paths por solicitud. */
export const MAX_PATHS_FIRMA = 100;

/** Largo máximo de un path (Storage acepta 1024 en `name`). */
export const LARGO_MAX_PATH = 1024;

export function esBucketFirmable(bucket: string): bucket is BucketFirmable {
  return (BUCKETS_FIRMABLES as readonly string[]).includes(bucket);
}

/** ¿Este rol puede firmar este bucket (ya en la lista blanca)? */
export function rolPuedeFirmar(rol: Rol, bucket: BucketFirmable): boolean {
  return ROLES_POR_BUCKET[bucket]?.includes(rol) ?? false;
}

/** Motivo (es-MX) por el que un path no se firma; `null` = válido. */
export function motivoPathInvalido(path: string): string | null {
  if (path.length > LARGO_MAX_PATH) {
    return `mide más de ${LARGO_MAX_PATH} caracteres`;
  }
  if (path.includes('://')) {
    return 'es una URL completa; manda la ruta dentro del bucket';
  }
  if (path.startsWith('/')) return 'empieza con «/»';
  if (path.includes('\\')) return 'trae «\\»';
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return 'trae caracteres de control';
  }
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) {
    return 'trae segmentos «.» o «..»';
  }
  return null;
}

/** Sin vacíos y sin repetidos, en el orden de llegada. */
export function pathsAFirmar(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((p) => p.length > 0))];
}

export type SolicitudFirma =
  | { ok: true; bucket: BucketFirmable; paths: string[] }
  | {
      ok: false;
      status: 400 | 403;
      code:
        | 'BUCKET_NO_PERMITIDO'
        | 'BUCKET_FUERA_DE_ROL'
        | 'DEMASIADOS_PATHS'
        | 'PATH_INVALIDO';
      message: string;
      details: Record<string, unknown>;
    };

/**
 * Valida una solicitud completa, en este orden: bucket en la lista blanca
 * (400) → rol con permiso sobre ese bucket (403) → tope de paths (400) →
 * cada path (400 con el PRIMERO inválido). Devuelve los paths limpios.
 */
export function validarSolicitudFirma(
  rol: Rol,
  bucket: string,
  paths: readonly string[],
): SolicitudFirma {
  if (!esBucketFirmable(bucket)) {
    return {
      ok: false,
      status: 400,
      code: 'BUCKET_NO_PERMITIDO',
      message: `No se pueden firmar archivos del bucket «${bucket}».`,
      details: { bucket, permitidos: [...BUCKETS_FIRMABLES] },
    };
  }
  if (!rolPuedeFirmar(rol, bucket)) {
    return {
      ok: false,
      status: 403,
      code: 'BUCKET_FUERA_DE_ROL',
      message: ROLES_TRIPULACION_FIRMA.includes(rol)
        ? 'Tu rol solo puede ver fotos de gastos y de tacómetros; pide a la oficina este archivo.'
        : 'Tu rol no tiene acceso a este archivo; pídeselo a administración.',
      details: { bucket, rol },
    };
  }
  if (paths.length > MAX_PATHS_FIRMA) {
    return {
      ok: false,
      status: 400,
      code: 'DEMASIADOS_PATHS',
      message: `Máximo ${MAX_PATHS_FIRMA} archivos por solicitud (llegaron ${paths.length}).`,
      details: { maximo: MAX_PATHS_FIRMA, recibidos: paths.length },
    };
  }
  const limpios = pathsAFirmar(paths);
  for (const p of limpios) {
    const motivo = motivoPathInvalido(p);
    if (motivo) {
      return {
        ok: false,
        status: 400,
        code: 'PATH_INVALIDO',
        message: `Ruta de archivo inválida: ${motivo}.`,
        details: { path: p.slice(0, 200), motivo },
      };
    }
  }
  return { ok: true, bucket, paths: limpios };
}
