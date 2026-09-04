/**
 * Payload del CLON de un vuelo (reasignación de aeronave de último minuto,
 * `reassignAircraft`): parte del spread de la fila original (`select('*')`)
 * y retira SOLO lo que no debe viajar. Helper puro (4-sep-2026) con spec
 * para garantizar que la liga de GRUPO (`grupo_id`, `grupo_posicion`,
 * `grupo_pax`) SÍ viaja al clon: el hijo cambia de avión pero sigue siendo
 * el avión k de N del grupo — el original cancelado queda fuera del
 * consolidado (los lectores excluyen cancelados; no hay índice único por
 * posición a propósito).
 */

/** Columnas que NUNCA se copian al clon. */
export const CAMPOS_NO_CLONABLES: readonly string[] = [
  'id',
  'folio',
  'created_at',
  'updated_at',
  'google_calendar_id',
  'foto_plan_vuelo_url',
  // La liga de combinación no viaja al clon (el original la rompe antes de
  // clonar; el spread de `original` se lee ANTES de romperla).
  'combinado_con_id',
  // GENERATED ALWAYS en la BD (se calcula sola del origen): insertarla revienta.
  'pago_anticipado_req',
];

export function payloadClonVuelo(
  original: Record<string, unknown>,
  p: { aeronaveId: string; userId: string; matricula: string },
): Record<string, unknown> {
  const clon: Record<string, unknown> = { ...original };
  for (const k of CAMPOS_NO_CLONABLES) delete clon[k];
  clon.aeronave_id = p.aeronaveId;
  clon.created_by = p.userId;
  clon.updated_by = p.userId;
  clon.notas_internas = [
    (original.notas_internas as string | null) ?? '',
    `Reasignado desde el vuelo #${original.folio as number} (cambio de aeronave a ${p.matricula}).`,
  ]
    .filter(Boolean)
    .join('\n');
  return clon;
}
