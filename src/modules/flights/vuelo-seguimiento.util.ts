/**
 * SEGUIMIENTO DE LA COTIZACIÓN por vuelo (29-sep-2026) — reglas PURAS.
 *
 * Pedido del cliente (detalle del vuelo #358): «un apartado para poner unas
 * notas que se deben agregar a la cotización. Ejemplo: Pablo ya terminó el
 * vuelito de hoy y los pax pidieron un transporte el cual no está incluido en
 * la cotización pero se necesita cobrar».
 *
 * Tabla `vuelo_seguimiento` (migración `20260929000002`): nota con estado
 * PENDIENTE → RESUELTA (quién/cuándo/cómo) y reabrir; `afecta_cotizacion`
 * (default true) = «debe reflejarse en la cotización». Soft delete: TODO
 * lector filtra `deleted_at is null`.
 *
 * FUENTE ÚNICA de: el orden de la lista (PENDIENTE primero, luego lo más
 * reciente), los contadores ADITIVOS del detalle/snapshot/cotización, el
 * detalle del banner del cotizador, el parche de PATCH (sellos de resuelta) y
 * el aviso NO bloqueante del pre-cierre. Sin I/O: el service y el pre-cierre
 * leen y esto decide.
 */
import { BadRequestException } from '@nestjs/common';
import { Rol } from '../../common/types/auth.types';

/** Migración que crea la tabla. */
export const MIGRACION_VUELO_SEGUIMIENTO = '20260929000002';

export const SEGUIMIENTO_TEXTO_MAX = 1000;
export const SEGUIMIENTO_RESOLUCION_MAX = 500;
/** Tope del detalle que viaja en la cotización (banner del cotizador). */
export const SEGUIMIENTO_DETALLE_MAX = 20;
/** Folios que el texto del pre-cierre enumera antes de «y N más». */
export const SEGUIMIENTO_FOLIOS_EN_TEXTO = 15;

export const ESTADOS_SEGUIMIENTO = ['PENDIENTE', 'RESUELTA'] as const;
export type EstadoSeguimiento = (typeof ESTADOS_SEGUIMIENTO)[number];

/** Clave del aviso del pre-cierre (NO está en `bloqueantes`). */
export const CLAVE_PRECIERRE_SEGUIMIENTO = 'seguimiento_cotizacion_pendiente';
/** Página de la lectura del pre-cierre (= max-rows de PostgREST). */
export const SEGUIMIENTO_PRECIERRE_PAGINA = 1000;
/** Tope de páginas del pre-cierre (20,000 notas ⇒ error de premisa). */
export const SEGUIMIENTO_PRECIERRE_MAX_PAGINAS = 20;

/** Columnas que leen la lista y las escrituras (sin `deleted_*`). */
export const COLS_SEGUIMIENTO =
  'id, vuelo_id, texto, afecta_cotizacion, estado, created_at, created_by, updated_at, resuelta_at, resuelta_por, resolucion';

/** Fila cruda de `vuelo_seguimiento` (lo que devuelve PostgREST). */
export interface SeguimientoRow {
  id: string;
  vuelo_id: string;
  texto: string;
  afecta_cotizacion: boolean;
  estado: string;
  created_at: string;
  created_by: string | null;
  updated_at?: string | null;
  resuelta_at: string | null;
  resuelta_por: string | null;
  resolucion: string | null;
  deleted_at?: string | null;
}

/** Usuario presentable: `nombre` null si no resuelve (jamás un uuid). */
export interface UsuarioRef {
  id: string | null;
  nombre: string | null;
}

/** Nota tal como la entrega el API (contrato del panel). */
export interface NotaSeguimiento {
  id: string;
  vuelo_id: string;
  texto: string;
  afecta_cotizacion: boolean;
  estado: EstadoSeguimiento;
  created_at: string;
  updated_at: string | null;
  /** SIEMPRE objeto (usuario borrado ⇒ `{id: null, nombre: null}`). */
  creado_por: UsuarioRef;
  resuelta_at: string | null;
  /** null mientras está PENDIENTE. */
  resuelta_por: UsuarioRef | null;
  resolucion: string | null;
}

/** Contadores ADITIVOS del detalle/snapshot/cotización. */
export interface ContadoresSeguimiento {
  /** Notas PENDIENTE no borradas. */
  seguimiento_pendientes: number;
  /** Las PENDIENTE con `afecta_cotizacion`. */
  seguimiento_cotizacion_pendientes: number;
}

/** Renglón del banner del cotizador. */
export interface SeguimientoPendienteDetalle {
  id: string;
  texto: string;
  created_at: string;
  creado_por_nombre: string | null;
}

export const CONTADORES_EN_CERO: Readonly<ContadoresSeguimiento> =
  Object.freeze({
    seguimiento_pendientes: 0,
    seguimiento_cotizacion_pendientes: 0,
  });

function estadoDe(v: unknown): EstadoSeguimiento {
  return v === 'RESUELTA' ? 'RESUELTA' : 'PENDIENTE';
}

function ms(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function vivas<T extends { deleted_at?: string | null }>(
  filas: ReadonlyArray<T>,
): T[] {
  return filas.filter((f) => f.deleted_at == null);
}

/**
 * Orden de la lista: PENDIENTE primero y, dentro de cada estado, la más
 * RECIENTE arriba (`created_at` desc; empate por id desc para que el orden
 * sea estable entre lecturas). No muta la entrada.
 */
export function ordenarNotas<
  T extends { id: string; estado: string; created_at: string },
>(filas: ReadonlyArray<T>): T[] {
  return [...filas].sort((a, b) => {
    const pa = estadoDe(a.estado) === 'PENDIENTE' ? 0 : 1;
    const pb = estadoDe(b.estado) === 'PENDIENTE' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const dt = ms(b.created_at) - ms(a.created_at);
    if (dt !== 0) return dt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** Contadores de UN vuelo (las borradas no cuentan). */
export function contarPendientes(
  filas: ReadonlyArray<
    Pick<SeguimientoRow, 'estado' | 'afecta_cotizacion' | 'deleted_at'>
  >,
): ContadoresSeguimiento {
  let pendientes = 0;
  let cotizacion = 0;
  for (const f of vivas(filas)) {
    if (estadoDe(f.estado) !== 'PENDIENTE') continue;
    pendientes += 1;
    if (f.afecta_cotizacion === true) cotizacion += 1;
  }
  return {
    seguimiento_pendientes: pendientes,
    seguimiento_cotizacion_pendientes: cotizacion,
  };
}

/**
 * Detalle del banner del cotizador: SOLO las PENDIENTE que afectan la
 * cotización, más reciente primero, máximo `SEGUIMIENTO_DETALLE_MAX`.
 */
export function detallePendientesCotizacion(
  filas: ReadonlyArray<SeguimientoRow>,
  nombres: ReadonlyMap<string, string>,
): SeguimientoPendienteDetalle[] {
  const pendientes = vivas(filas).filter(
    (f) => estadoDe(f.estado) === 'PENDIENTE' && f.afecta_cotizacion === true,
  );
  return ordenarNotas(pendientes)
    .slice(0, SEGUIMIENTO_DETALLE_MAX)
    .map((f) => ({
      id: f.id,
      texto: f.texto,
      created_at: f.created_at,
      creado_por_nombre: f.created_by
        ? (nombres.get(f.created_by) ?? null)
        : null,
    }));
}

function refUsuario(
  id: string | null,
  nombres: ReadonlyMap<string, string>,
): UsuarioRef {
  return { id: id ?? null, nombre: id ? (nombres.get(id) ?? null) : null };
}

/** Fila cruda → nota del contrato (nombres ya resueltos en lote). */
export function aNota(
  f: SeguimientoRow,
  nombres: ReadonlyMap<string, string>,
): NotaSeguimiento {
  const estado = estadoDe(f.estado);
  return {
    id: f.id,
    vuelo_id: f.vuelo_id,
    texto: f.texto,
    afecta_cotizacion: f.afecta_cotizacion === true,
    estado,
    created_at: f.created_at,
    updated_at: f.updated_at ?? null,
    creado_por: refUsuario(f.created_by, nombres),
    resuelta_at: estado === 'RESUELTA' ? f.resuelta_at : null,
    resuelta_por:
      estado === 'RESUELTA' ? refUsuario(f.resuelta_por, nombres) : null,
    resolucion: estado === 'RESUELTA' ? (f.resolucion ?? null) : null,
  };
}

/** Ids de usuario DISTINTOS que la lista necesita resolver. */
export function idsUsuariosDeNotas(
  filas: ReadonlyArray<Pick<SeguimientoRow, 'created_by' | 'resuelta_por'>>,
): string[] {
  const s = new Set<string>();
  for (const f of filas) {
    if (f.created_by) s.add(f.created_by);
    if (f.resuelta_por) s.add(f.resuelta_por);
  }
  return [...s];
}

/** Texto de la nota: recortado; vacío o > 1000 ⇒ 400 (el CHECK lo repite). */
export function normalizarTexto(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length === 0) {
    throw new BadRequestException({
      message: 'Escribe la nota: no puede ir vacía.',
      error: 'SEGUIMIENTO_TEXTO_VACIO',
    });
  }
  if (t.length > SEGUIMIENTO_TEXTO_MAX) {
    throw new BadRequestException({
      message: `La nota admite hasta ${SEGUIMIENTO_TEXTO_MAX} caracteres.`,
      error: 'SEGUIMIENTO_TEXTO_LARGO',
    });
  }
  return t;
}

/** Resolución: recortada; "" o null ⇒ null (sin resolución escrita). */
export function normalizarResolucion(v: unknown): string | null {
  if (v == null) return null;
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length === 0) return null;
  if (t.length > SEGUIMIENTO_RESOLUCION_MAX) {
    throw new BadRequestException({
      message: `«¿Cómo se resolvió?» admite hasta ${SEGUIMIENTO_RESOLUCION_MAX} caracteres.`,
      error: 'SEGUIMIENTO_RESOLUCION_LARGA',
    });
  }
  return t;
}

/** Lo que manda PATCH (todo opcional). */
export interface CambiosSeguimiento {
  estado?: EstadoSeguimiento;
  resolucion?: string | null;
  texto?: string;
  afecta_cotizacion?: boolean;
}

/**
 * Parche de UPDATE a partir de la fila VIGENTE y lo pedido. Reglas:
 * - `estado: RESUELTA` desde PENDIENTE SELLA `resuelta_at = ahora` y
 *   `resuelta_por = usuario` (+ la resolución si viene). Sobre una que YA
 *   está resuelta NO re-sella (conserva quién y cuándo) y solo cambia la
 *   resolución si viene.
 * - `estado: PENDIENTE` (reabrir) LIMPIA sello y resolución (el CHECK de BD
 *   lo exige: una pendiente no arrastra quién ni cómo).
 * - `resolucion` sin `estado` sobre una PENDIENTE ⇒ 400 (no hay qué
 *   resolver); con `estado: PENDIENTE` también.
 * - Cuerpo sin NINGÚN campo ⇒ 400. Pedir el estado que ya tiene (doble clic
 *   en «Marcar resuelta», dos personas a la vez) ⇒ parche VACÍO: el service
 *   responde la nota tal cual (idempotente, sin re-sellar).
 */
export function parcheSeguimiento(
  actual: Pick<SeguimientoRow, 'estado'>,
  cambios: CambiosSeguimiento,
  userId: string,
  ahoraIso: string,
): Record<string, unknown> {
  if (
    cambios.texto === undefined &&
    cambios.afecta_cotizacion === undefined &&
    cambios.estado === undefined &&
    cambios.resolucion === undefined
  ) {
    throw new BadRequestException({
      message: 'No hay nada que actualizar en la nota.',
      error: 'SEGUIMIENTO_SIN_CAMBIOS',
    });
  }
  const patch: Record<string, unknown> = {};
  if (cambios.texto !== undefined) {
    patch.texto = normalizarTexto(cambios.texto);
  }
  if (cambios.afecta_cotizacion !== undefined) {
    // Solo un booleano REAL cambia la bandera: `null` (o cualquier otra
    // cosa) jamás se lee como `false` — apagaría el banner y el pre-cierre
    // en silencio. El DTO ya lo rebota; esto es la segunda línea.
    if (typeof cambios.afecta_cotizacion !== 'boolean') {
      throw new BadRequestException({
        message: '«Debe reflejarse en la cotización» debe ser sí o no.',
        error: 'SEGUIMIENTO_AFECTA_INVALIDO',
      });
    }
    patch.afecta_cotizacion = cambios.afecta_cotizacion;
  }
  const estadoActual = estadoDe(actual.estado);
  const estadoNuevo = cambios.estado ?? estadoActual;
  const trae = cambios.resolucion !== undefined;
  if (estadoNuevo === 'PENDIENTE') {
    if (trae && normalizarResolucion(cambios.resolucion) !== null) {
      throw new BadRequestException({
        message:
          'La resolución solo aplica a una nota resuelta: márcala como resuelta para escribir cómo se resolvió.',
        error: 'SEGUIMIENTO_RESOLUCION_SIN_RESOLVER',
      });
    }
    if (estadoActual === 'RESUELTA') {
      patch.estado = 'PENDIENTE';
      patch.resuelta_at = null;
      patch.resuelta_por = null;
      patch.resolucion = null;
    }
  } else {
    if (estadoActual === 'PENDIENTE') {
      patch.estado = 'RESUELTA';
      patch.resuelta_at = ahoraIso;
      patch.resuelta_por = userId;
      patch.resolucion = normalizarResolucion(cambios.resolucion);
    } else if (trae) {
      patch.resolucion = normalizarResolucion(cambios.resolucion);
    }
  }
  return patch;
}

// ===== Pre-cierre =====

/** Fila que lee el pre-cierre (nota + su vuelo embebido). */
export interface SeguimientoPrecierreRow {
  vuelo_id: string;
  vuelo:
    | {
        id?: string;
        folio?: number | string | null;
        estado?: string | null;
        fecha_vuelo?: string | null;
      }
    | Array<{
        id?: string;
        folio?: number | string | null;
        estado?: string | null;
        fecha_vuelo?: string | null;
      }>
    | null;
}

export interface VueloConSeguimientoPendiente {
  id: string;
  folio: number;
  estado: string | null;
  fecha_vuelo: string | null;
  /** Notas PENDIENTE con `afecta_cotizacion` de ese vuelo. */
  notas: number;
}

/** «N vuelo(s) con ajustes pendientes de reflejar en la cotización: #a, #b…». */
export function textoPrecierreSeguimiento(
  folios: ReadonlyArray<number>,
): string {
  const n = folios.length;
  if (n === 0) {
    return 'Ningún vuelo del periodo tiene ajustes pendientes de reflejar en la cotización.';
  }
  const visibles = folios
    .slice(0, SEGUIMIENTO_FOLIOS_EN_TEXTO)
    .map((f) => `#${f}`)
    .join(', ');
  const resto = n - Math.min(n, SEGUIMIENTO_FOLIOS_EN_TEXTO);
  const lista = resto > 0 ? `${visibles} y ${resto} más` : visibles;
  return `${n} vuelo(s) con ajustes pendientes de reflejar en la cotización: ${lista}. Agrégalos a la cotización y márcalos como resueltos en el detalle del vuelo → «Seguimiento de la cotización».`;
}

/**
 * Agrupa por vuelo las notas PENDIENTE que afectan la cotización (el SELECT
 * ya filtró estado/afecta/borradas/periodo) y arma el renglón del aviso,
 * ordenado por folio. Un vuelo sin folio legible sale con folio 0 (jamás se
 * pierde del conteo).
 */
export function resumenPrecierreSeguimiento(
  filas: ReadonlyArray<SeguimientoPrecierreRow>,
): {
  count: number;
  notas: number;
  detalle: string;
  vuelos: VueloConSeguimientoPendiente[];
} {
  const porVuelo = new Map<string, VueloConSeguimientoPendiente>();
  for (const f of filas) {
    const v = Array.isArray(f.vuelo) ? f.vuelo[0] : f.vuelo;
    const id = f.vuelo_id;
    if (!id) continue;
    const previo = porVuelo.get(id);
    if (previo) {
      previo.notas += 1;
      continue;
    }
    const folio = Number(v?.folio);
    porVuelo.set(id, {
      id,
      folio: Number.isFinite(folio) ? folio : 0,
      estado: v?.estado ?? null,
      fecha_vuelo: v?.fecha_vuelo ?? null,
      notas: 1,
    });
  }
  const vuelos = [...porVuelo.values()].sort(
    (a, b) => a.folio - b.folio || (a.id < b.id ? -1 : 1),
  );
  return {
    count: vuelos.length,
    notas: vuelos.reduce((acc, v) => acc + v.notas, 0),
    detalle: textoPrecierreSeguimiento(vuelos.map((v) => v.folio)),
    vuelos,
  };
}

// ===== Roles (RolesGuard default-deny: cada ruta declara los suyos) =====

/** Leen la lista: oficina + SOCIO/ANALISTA (solo GET). */
export const ROLES_SEGUIMIENTO_LECTURA: readonly Rol[] = Object.freeze([
  Rol.ADMIN,
  Rol.COORDINADOR,
  Rol.FACTURACION,
  Rol.SOCIO,
  Rol.ANALISTA,
]);

/** Crean, resuelven/reabren, editan y borran notas. */
export const ROLES_SEGUIMIENTO_ESCRITURA: readonly Rol[] = Object.freeze([
  Rol.ADMIN,
  Rol.COORDINADOR,
  Rol.FACTURACION,
]);

/**
 * ¿El rol recibe los contadores ADITIVOS en el detalle/snapshot? Los mismos
 * que leen la lista: la tripulación (PILOTO/MECANICO) y el VISITANTE no.
 */
export function rolVeSeguimiento(
  rol: Rol | string | null | undefined,
): boolean {
  return ROLES_SEGUIMIENTO_LECTURA.includes(rol as Rol);
}
