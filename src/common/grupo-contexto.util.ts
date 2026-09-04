import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Contexto de GRUPO de un vuelo hijo para avisos y lectores (4-sep-2026):
 * "Grupo G-12 · avión 3 de 7 · 44 pax". FUENTE ÚNICA del texto y del conteo
 * de aviones vivos del grupo (los cancelados no cuentan: un hijo
 * reasignado de avión deja su original CANCELADO con la misma posición).
 * La cabecera del grupo no tiene dinero ni estado: aquí solo se leen folio,
 * pasajeros_total y el conteo. Best-effort: cualquier error ⇒ null.
 */

export interface ContextoGrupo {
  id: string;
  folio: number | null;
  posicion: number | null;
  total_aviones: number | null;
  pasajeros_total: number | null;
  /** "Grupo G-12 · avión 3 de 7 · 44 pax" */
  texto: string;
}

export function textoContextoGrupo(p: {
  folio: number | null;
  posicion: number | null;
  total_aviones: number | null;
  pasajeros_total: number | null;
}): string {
  const partes = [`Grupo G-${p.folio ?? '?'}`];
  if (p.posicion != null) {
    partes.push(
      `avión ${p.posicion}${p.total_aviones ? ` de ${p.total_aviones}` : ''}`,
    );
  }
  if (p.pasajeros_total) partes.push(`${p.pasajeros_total} pax`);
  return partes.join(' · ');
}

/** Datos planos (sin `texto`) para `data` de una notificación. */
export function datosGrupo(g: ContextoGrupo): Omit<ContextoGrupo, 'texto'> {
  return {
    id: g.id,
    folio: g.folio,
    posicion: g.posicion,
    total_aviones: g.total_aviones,
    pasajeros_total: g.pasajeros_total,
  };
}

/** Aviones VIVOS (no cancelados) del grupo. null si no se pudo leer. */
export async function totalAvionesDeGrupo(
  sb: SupabaseClient,
  grupoId: string,
): Promise<number | null> {
  try {
    const { count, error } = await sb
      .from('vuelo')
      .select('id', { count: 'exact', head: true })
      .eq('grupo_id', grupoId)
      .neq('estado', 'CANCELADO');
    if (error) return null;
    return count ?? null;
  } catch {
    return null;
  }
}

/**
 * Contexto del hijo a partir de su fila (`grupo_id`, `grupo_posicion` y, si
 * viene, el embed `grupo {folio, pasajeros_total}` de VUELO_COLS; sin el
 * embed se lee la cabecera). null si el vuelo no es de grupo.
 */
export async function contextoGrupoDeVuelo(
  sb: SupabaseClient,
  vuelo: Record<string, unknown> | null | undefined,
): Promise<ContextoGrupo | null> {
  const grupoId = (vuelo?.grupo_id as string | null | undefined) ?? null;
  if (!grupoId) return null;
  try {
    const emb = vuelo?.grupo as
      | { folio?: number | null; pasajeros_total?: number | null }
      | Array<{ folio?: number | null; pasajeros_total?: number | null }>
      | null
      | undefined;
    const g = Array.isArray(emb) ? emb[0] : emb;
    let folio: number | null = g?.folio != null ? Number(g.folio) : null;
    let paxTotal: number | null =
      g?.pasajeros_total != null ? Number(g.pasajeros_total) : null;
    if (folio == null) {
      const { data } = await sb
        .from('vuelo_grupo')
        .select('folio, pasajeros_total')
        .eq('id', grupoId)
        .maybeSingle();
      folio = data?.folio != null ? Number(data.folio) : null;
      paxTotal =
        data?.pasajeros_total != null ? Number(data.pasajeros_total) : null;
    }
    const total = await totalAvionesDeGrupo(sb, grupoId);
    const posicion =
      vuelo?.grupo_posicion != null ? Number(vuelo.grupo_posicion) : null;
    const base = {
      folio,
      posicion,
      total_aviones: total,
      pasajeros_total: paxTotal,
    };
    return { id: grupoId, ...base, texto: textoContextoGrupo(base) };
  } catch {
    return null;
  }
}

export type AccionBajaHijo = 'cancelado' | 'eliminado' | 'purgado';

/**
 * Aviso a oficina (ADMIN/COORDINADOR, tipo `alerta_sistema`) cuando un
 * HIJO de grupo se cancela/elimina desde el detalle del vuelo (fuera del
 * grupo): "El avión 3 de 7 del grupo G-12 fue cancelado". El consolidado
 * del grupo ya excluye cancelados; este aviso existe para que nadie
 * descubra el hueco el día del vuelo. Puro: el caller entrega.
 */
export function avisoBajaHijoDeGrupo(
  ctx: ContextoGrupo,
  vuelo: {
    id?: unknown;
    folio?: unknown;
    origen_iata?: unknown;
    destino_iata?: unknown;
  },
  accion: AccionBajaHijo,
): {
  tipo: string;
  titulo: string;
  cuerpo: string;
  data: Record<string, unknown>;
  link: string;
} {
  const posicion =
    ctx.posicion != null
      ? `El avión ${ctx.posicion}${ctx.total_aviones ? ` de ${ctx.total_aviones}` : ''}`
      : 'Un avión';
  const verbo =
    accion === 'cancelado'
      ? 'fue cancelado'
      : accion === 'eliminado'
        ? 'fue eliminado'
        : 'fue eliminado definitivamente';
  const ruta =
    typeof vuelo.origen_iata === 'string' &&
    typeof vuelo.destino_iata === 'string'
      ? ` (${vuelo.origen_iata} → ${vuelo.destino_iata})`
      : '';
  return {
    tipo: 'alerta_sistema',
    titulo: `Grupo G-${ctx.folio ?? '?'}: avión ${verbo}`,
    cuerpo: `${posicion} del grupo G-${ctx.folio ?? '?'} (vuelo #${
      typeof vuelo.folio === 'number' || typeof vuelo.folio === 'string'
        ? String(vuelo.folio)
        : '?'
    })${ruta} ${verbo} fuera del grupo. El total del grupo ya no lo incluye; revisa pasajeros y extras del grupo.`,
    data: {
      grupo_id: ctx.id,
      grupo_folio: ctx.folio,
      vuelo_id: vuelo.id ?? null,
      folio: vuelo.folio ?? null,
      accion,
    },
    link: `/admin/quotes/grupo/${ctx.id}`,
  };
}
