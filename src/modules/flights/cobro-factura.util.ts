/**
 * FACTURAS POR COBRO — LIGAR UN COBRO A UNA FACTURA (16-oct-2026, API
 * 0.0.82, invariante 84). Regla PURA, espejo EXACTO del trigger A
 * `tg_cobro_vuelo_factura_coherente` de la migración 20261016000001 (mismos
 * códigos, en el MISMO orden): el service la corre ANTES de escribir para
 * responder 400/409 con texto es-MX, y si una carrera deja pasar algo, el
 * trigger rebota 23514 con `hint = CODIGO` y `detail` JSON y
 * `leerErrorCobroFactura` lo convierte en el MISMO 400/409 (nunca 500).
 *
 * Sin excepción de «vuelo hermano de grupo» (revisión 16-oct): la burbuja,
 * `cobros_n`, `SIN_COBRO_ASIGNADO` y `facturas_con_cobro` del pre-cierre
 * leen SOLO las facturas ligadas al vuelo del cobro; para amparar cobros de
 * un hermano se agrega ese vuelo a la factura con `vuelo_ids`.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { etiquetaSerieFolio } from './factura-cliente.util';

/** Códigos del trigger A, en el ORDEN en que los comprueba. */
export const CODIGOS_COBRO_FACTURA = [
  'REEMBOLSO_SIN_FACTURA',
  'COBRO_DE_GRUPO',
  'FACTURA_NO_VIGENTE',
  'FACTURA_NO_LIGADA_AL_VUELO',
] as const;
export type CodigoCobroFactura = (typeof CODIGOS_COBRO_FACTURA)[number];

/** Lo que se sabe del cobro al ligar (fila vigente o DTO del alta). */
export interface CobroParaLigar {
  id?: string | null;
  vuelo_id: string;
  monto: unknown;
  cobro_grupo_id?: unknown;
}

/** Factura leída para validar (`id, serie, folio, estatus, deleted_at`). */
export interface FacturaParaLigar {
  id: string;
  serie?: string | null;
  folio?: string | null;
  estatus?: string | null;
  deleted_at?: string | null;
}

export interface FalloCobroFactura {
  codigo: CodigoCobroFactura;
  details: Record<string, unknown>;
}

/** «A-0420» (o el id recortado si la factura no volvió). */
export function etiquetaDeFactura(
  f: FacturaParaLigar | null | undefined,
): string {
  if (!f) return 'elegida';
  return (
    etiquetaSerieFolio(f.serie ?? null, f.folio ?? null) ?? f.id.slice(0, 8)
  );
}

/**
 * Valida la liga cobro → factura con la regla del trigger A. `ligas` = filas
 * del puente `factura_emitida_vuelo` de la factura (basta con las del vuelo
 * del cobro). `null` = la liga es válida.
 */
export function validarFacturaParaCobro(
  cobro: CobroParaLigar,
  factura: FacturaParaLigar | null,
  ligas: ReadonlyArray<{ factura_id: string; vuelo_id: string }>,
  facturaId: string = factura?.id ?? '',
): FalloCobroFactura | null {
  const monto = Number(cobro.monto);
  if (!Number.isFinite(monto) || monto <= 0) {
    return {
      codigo: 'REEMBOLSO_SIN_FACTURA',
      details: { cobro_id: cobro.id ?? null },
    };
  }
  if (typeof cobro.cobro_grupo_id === 'string' && cobro.cobro_grupo_id) {
    return {
      codigo: 'COBRO_DE_GRUPO',
      details: {
        cobro_id: cobro.id ?? null,
        cobro_grupo_id: cobro.cobro_grupo_id,
      },
    };
  }
  if (!factura || factura.deleted_at || factura.estatus !== 'VIGENTE') {
    return {
      codigo: 'FACTURA_NO_VIGENTE',
      details: {
        factura_id: facturaId,
        estatus: factura?.estatus ?? null,
        borrada: !!factura?.deleted_at,
      },
    };
  }
  const ligada = ligas.some(
    (l) => l.factura_id === factura.id && l.vuelo_id === cobro.vuelo_id,
  );
  if (!ligada) {
    return {
      codigo: 'FACTURA_NO_LIGADA_AL_VUELO',
      details: { factura_id: factura.id, vuelo_id: cobro.vuelo_id },
    };
  }
  return null;
}

/** Textos es-MX del contrato (§3.1) por código. */
export function mensajeCobroFactura(
  codigo: CodigoCobroFactura,
  ctx: { etiqueta?: string | null; folio?: number | null } = {},
): string {
  const etiqueta = ctx.etiqueta || 'elegida';
  switch (codigo) {
    case 'REEMBOLSO_SIN_FACTURA':
      return 'Un reembolso no se liga a una factura.';
    case 'COBRO_DE_GRUPO':
      return 'Este cobro es parte de un sobre de grupo: la parte de un sobre no lleva factura por vuelo.';
    case 'FACTURA_NO_VIGENTE':
      return `La factura ${etiqueta} ya no está vigente (o no existe): recarga la página y elige otra.`;
    case 'FACTURA_NO_LIGADA_AL_VUELO':
      return `La factura ${etiqueta} no está ligada al vuelo #${ctx.folio ?? '?'}. Agrégale el vuelo en Facturas emitidas → Editar → Vuelos y vuelve a intentar.`;
  }
}

/** 400 (`REEMBOLSO_SIN_FACTURA`) o 409 (los demás) estructurado. */
export function errorCobroFactura(
  fallo: FalloCobroFactura,
  ctx: { etiqueta?: string | null; folio?: number | null } = {},
): BadRequestException | ConflictException {
  const body = {
    message: mensajeCobroFactura(fallo.codigo, ctx),
    error: fallo.codigo,
    details: {
      ...fallo.details,
      ...(ctx.folio != null && fallo.codigo === 'FACTURA_NO_LIGADA_AL_VUELO'
        ? { folio: ctx.folio }
        : {}),
    },
  };
  return fallo.codigo === 'REEMBOLSO_SIN_FACTURA'
    ? new BadRequestException(body)
    : new ConflictException(body);
}

/** Error de PostgREST como llega al service (forma del trigger A). */
export interface ErrorCobroFacturaLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

/**
 * ¿El error es un 23514 del trigger A? Devuelve el fallo (código del
 * `hint` o del prefijo «CODIGO:» del mensaje y el `detail` JSON) o null.
 */
export function leerErrorCobroFactura(
  err: ErrorCobroFacturaLike | null | undefined,
): FalloCobroFactura | null {
  if (!err || err.code !== '23514') return null;
  const esCodigo = (c: unknown): c is CodigoCobroFactura =>
    typeof c === 'string' &&
    (CODIGOS_COBRO_FACTURA as readonly string[]).includes(c);
  const hint = typeof err.hint === 'string' ? err.hint.trim() : '';
  const msg = String(err.message ?? '');
  const prefijo = /^\s*([A-Z][A-Z_]+)\s*:/.exec(msg)?.[1];
  const codigo = esCodigo(hint) ? hint : esCodigo(prefijo) ? prefijo : null;
  if (!codigo) return null;
  let details: Record<string, unknown> = {};
  if (typeof err.details === 'string' && err.details.trim().startsWith('{')) {
    try {
      const v: unknown = JSON.parse(err.details);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        details = v as Record<string, unknown>;
      }
    } catch {
      details = {};
    }
  }
  return { codigo, details };
}
