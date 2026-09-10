/**
 * Llave de idempotencia reutilizada FUERA de su ámbito (10-sep-2026, Lote 2
 * Ola B · B2). Los índices únicos parciales de `client_request_id` son
 * GLOBALES por tabla, pero la relectura del replay se acota al padre de la
 * ruta (vuelo del tramo/cobro, avión del squawk, producto del movimiento)
 * para que un reintento NUNCA devuelva una fila ajena. Si el insert choca
 * (23505) y la relectura acotada no encuentra nada, la llave pertenece a
 * otro padre: 409 estructurado — jamás 500 (el outbox lo reintentaría para
 * siempre) ni la fila de otro.
 */
import { ConflictException } from '@nestjs/common';

export const CODE_CLIENT_REQUEST_ID_EN_USO = 'CLIENT_REQUEST_ID_EN_USO';

/** Entidades con alta idempotente y el ámbito donde se acota la relectura. */
export type EntidadConLlave = 'tramo' | 'cobro' | 'reporte' | 'movimiento';

const AMBITO: Record<EntidadConLlave, string> = {
  tramo: 'otro vuelo',
  cobro: 'otro vuelo',
  reporte: 'otro avión',
  movimiento: 'otro producto',
};

/** Texto del 409 (es-MX, para el usuario). */
export function mensajeClientRequestIdEnUso(entidad: EntidadConLlave): string {
  return `La llave client_request_id de este ${entidad} ya se usó en ${AMBITO[entidad]}; genera una llave nueva por captura.`;
}

/** 409 ESTRUCTURADO `CLIENT_REQUEST_ID_EN_USO` (el filtro lo expone como `code`). */
export function clientRequestIdEnUso(
  entidad: EntidadConLlave,
  key: string,
): ConflictException {
  return new ConflictException({
    message: mensajeClientRequestIdEnUso(entidad),
    error: CODE_CLIENT_REQUEST_ID_EN_USO,
    details: { client_request_id: key },
  });
}
