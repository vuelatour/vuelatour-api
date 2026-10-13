import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from '../../common/columna-opcional.util';
import { facturaEmitidaDisponible } from '../../common/factura-emitida-disponible.util';
import {
  cuentasQueExigenFactura,
  vueloExigeFactura,
  type CobroExigeFacturaRow,
  type ExigenciaFacturaVuelo,
} from '../../common/cuentas-cobro';
import {
  etiquetaCfdiVivo,
  etiquetaEmitidasVigentes,
  etiquetaFacturaRegistrada,
  etiquetaFacturaVuelo,
  type FacturaEmitidaEtiquetaRow,
  type VueloFacturaRow,
} from './factura-cliente.util';

/** Ids por consulta `.in(...)`: la URL de PostgREST no crece sin tope. */
const LOTE_IDS = 200;
/** max-rows de PostgREST: una respuesta NUNCA trae más filas. */
const PAGINA_COBROS = 1000;
/** Tope de páginas por lote (200 vuelos × 20,000 cobros ⇒ algo anda mal). */
const MAX_PAGINAS_COBROS = 20;

/** Fila de `vuelo` que lee este lector (columnas según las sondas). */
type VueloFacturaFila = VueloFacturaRow & {
  id: string;
  estado?: unknown;
  factura_solicitada_at?: unknown;
};

type CobroFila = CobroExigeFacturaRow & { id?: unknown; vuelo_id?: unknown };

/**
 * DETALLE de la factura de un vuelo (13-oct-2026, invariante 60): lo que la
 * columna pinta y lo que la solicitud automática y el pre-cierre necesitan
 * para decidir sin repetir la cascada.
 */
export interface FacturaDeVuelo {
  /** Pasos 1-4 de la cascada (CFDI vivo → emitidas → folio → estatus). */
  registrada: string | null;
  /** Según TODOS los cobros positivos del vuelo (`vueloExigeFactura`). */
  exigencia: ExigenciaFacturaVuelo;
  /** Solicitud VIVA (`vuelo.factura_solicitada_at`; false sin la migración). */
  solicitada: boolean;
  /** `vuelo.estado` (null si el vuelo no existe). */
  estado: string | null;
  /** `cuentaDeCobroTexto` distintos de los cobros que exigen. */
  cuentas_exigen: string[];
  /** Lo que dice la columna «FACTURA VUELATOUR» (`etiquetaFacturaVuelo`). */
  etiqueta: string | null;
}

/**
 * Cobros de un lote de vuelos, PAGINADOS de 1000 en 1000 (patrón
 * `leerEnLotesPaginado` de profit-sharing.service.ts): PostgREST corta en
 * max-rows = 1000 SIN avisar y un `.limit(10000)` NO lo supera — con 200
 * vuelos × parcialidades, un vuelo cuyos cobros cayeran después de la fila
 * 1000 saldría «sin cobros» en falso. Orden TOTAL por `id` para que las
 * páginas no se traslapen. Cualquier error LANZA.
 */
async function cobrosDeVuelosPaginado(
  sb: SupabaseClient,
  lote: string[],
): Promise<CobroFila[]> {
  const out: CobroFila[] = [];
  for (let pagina = 0; ; pagina += 1) {
    if (pagina >= MAX_PAGINAS_COBROS) {
      throw new Error(
        `más de ${MAX_PAGINAS_COBROS * PAGINA_COBROS} cobros en un lote de ${LOTE_IDS} vuelos al leer la factura`,
      );
    }
    const desde = pagina * PAGINA_COBROS;
    const { data, error } = await sb
      .from('cobro_vuelo')
      .select('id, vuelo_id, monto, cuenta_destino, metodo_cobro')
      .in('vuelo_id', lote)
      .order('id', { ascending: true })
      .range(desde, desde + PAGINA_COBROS - 1);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as CobroFila[];
    out.push(...filas);
    if (filas.length < PAGINA_COBROS) break;
  }
  return out;
}

/**
 * Factura de cada vuelo para los EXCEL, la solicitud automática y el
 * pre-cierre — FUENTE ÚNICA (24-sep-2026; detalle desde el 13-oct-2026,
 * invariante 60). Devuelve TODOS los ids pedidos (también los sin etiqueta).
 *
 * Cascada (pura, en `etiquetaFacturaVuelo`): CFDI vivo → facturas EMITIDAS
 * a mano VIGENTES del registro («A-123, A-130») → `vuelo.factura_folio`
 * (legado) → etiqueta del estatus («Facturado» / «Factura elaborada y
 * enviada») → paso 5 (13-oct-2026): sin factura registrada, «Pendiente de
 * factura» si algún cobro positivo cayó en una cuenta que exige factura
 * (`vueloExigeFactura`) o si hay solicitud VIVA desde el vuelo; «No lleva
 * factura» si hay cobros y ninguno exige; `null` = SIN COBROS (desde ahora
 * la celda vacía significa «sin cobros», no «sin factura»).
 *
 * EN LOTE: 4 consultas por cada 200 vuelos — `factura` + columnas de `vuelo`
 * + `cobro_vuelo` (PAGINADA, nunca `.limit()`) y la cuarta al puente
 * `factura_emitida_vuelo` SOLO con la migración 20260924000003 aplicada —
 * nunca N+1.
 *
 * Tolerante a las migraciones pendientes (`columnaOpcional`, re-sondeo ≤ 10
 * min): sin `20260923000001` se lee solo `facturado`; sin `20260924000001`
 * no se pide `factura_folio`; sin `20260924000003` no se consulta el
 * registro de emitidas ni se pide `factura_solicitada_at` (`solicitada:
 * false`) — el Excel sale igual que antes, jamás un 500. Cualquier OTRO
 * error de lectura (en cualquiera de las 4) se lanza (misma regla que el
 * resto del libro: nunca un reporte con una columna vacía en silencio).
 */
export async function facturasDeVuelos(
  sb: SupabaseClient,
  vueloIds: string[],
): Promise<Map<string, FacturaDeVuelo>> {
  const out = new Map<string, FacturaDeVuelo>();
  const ids = [...new Set(vueloIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const conEstatus = await columnaOpcional(sb, 'vuelo', 'factura_estatus', {
    mensajeAusente:
      'Columnas vuelo.factura_* no existen todavía: la factura del servicio se deriva de vuelo.facturado hasta aplicar la migración 20260923000001',
  }).disponible();
  const conFolio =
    conEstatus &&
    (await columnaOpcional(sb, 'vuelo', 'factura_folio', {
      mensajeAusente:
        'Columnas vuelo.factura_folio/factura_uuid no existen todavía: el folio de la factura del servicio no se guarda hasta aplicar la migración 20260924000001',
    }).disponible());
  const conEmitidas = await facturaEmitidaDisponible(sb);
  const colsVuelo = [
    'id',
    'facturado',
    ...(conEstatus ? ['factura_estatus'] : []),
    ...(conFolio ? ['factura_folio'] : []),
    'estado',
    ...(conEmitidas ? ['factura_solicitada_at'] : []),
  ].join(', ');

  const cfdiPorVuelo = new Map<string, Array<Record<string, unknown>>>();
  const vueloPorId = new Map<string, VueloFacturaFila>();
  const emitidasPorVuelo = new Map<string, FacturaEmitidaEtiquetaRow[]>();
  const cobrosPorVuelo = new Map<string, CobroFila[]>();
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    const lote = ids.slice(i, i + LOTE_IDS);
    const [facturasRes, vuelosRes, emitidasRes, cobros] = await Promise.all([
      sb
        .from('factura')
        .select('vuelo_id, serie, folio, estado')
        .in('vuelo_id', lote)
        .neq('estado', 'CANCELADA'),
      sb.from('vuelo').select(colsVuelo).in('id', lote),
      conEmitidas
        ? sb
            .from('factura_emitida_vuelo')
            .select(
              'vuelo_id, factura:factura_emitida!inner(serie, folio, folio_num, estatus, deleted_at)',
            )
            .in('vuelo_id', lote)
        : Promise.resolve({ data: [], error: null }),
      cobrosDeVuelosPaginado(sb, lote),
    ]);
    if (facturasRes.error) throw new Error(facturasRes.error.message);
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    if (emitidasRes.error) throw new Error(emitidasRes.error.message);
    for (const f of (facturasRes.data ?? []) as Array<
      Record<string, unknown>
    >) {
      const vid = f.vuelo_id as string;
      if (!vid) continue;
      (cfdiPorVuelo.get(vid) ?? cfdiPorVuelo.set(vid, []).get(vid)!).push(f);
    }
    for (const v of (vuelosRes.data ?? []) as unknown as VueloFacturaFila[]) {
      vueloPorId.set(v.id, v);
    }
    // El filtro VIGENTE / no borrada lo aplica la cascada pura
    // (`etiquetaEmitidasVigentes`): una sola regla para todos los lectores.
    for (const l of (emitidasRes.data ?? []) as Array<{
      vuelo_id?: string;
      factura?: FacturaEmitidaEtiquetaRow | FacturaEmitidaEtiquetaRow[] | null;
    }>) {
      const vid = l.vuelo_id;
      const f = Array.isArray(l.factura) ? l.factura[0] : l.factura;
      if (!vid || !f) continue;
      (
        emitidasPorVuelo.get(vid) ?? emitidasPorVuelo.set(vid, []).get(vid)!
      ).push(f);
    }
    for (const c of cobros) {
      const vid = typeof c.vuelo_id === 'string' ? c.vuelo_id : '';
      if (!vid) continue;
      (cobrosPorVuelo.get(vid) ?? cobrosPorVuelo.set(vid, []).get(vid)!).push(
        c,
      );
    }
  }

  for (const id of ids) {
    const v = vueloPorId.get(id) ?? null;
    const cobros = cobrosPorVuelo.get(id) ?? [];
    const base = {
      cfdi: etiquetaCfdiVivo(cfdiPorVuelo.get(id) ?? []),
      emitidas: etiquetaEmitidasVigentes(emitidasPorVuelo.get(id) ?? []),
      vuelo: v,
    };
    const exigencia = vueloExigeFactura(cobros);
    const solicitada =
      v?.factura_solicitada_at != null && v.factura_solicitada_at !== '';
    out.set(id, {
      registrada: etiquetaFacturaRegistrada(base),
      exigencia,
      solicitada,
      estado: typeof v?.estado === 'string' ? v.estado : null,
      cuentas_exigen: cuentasQueExigenFactura(cobros),
      etiqueta: etiquetaFacturaVuelo({ ...base, exigencia, solicitada }),
    });
  }
  return out;
}

/**
 * Etiqueta de la factura de cada vuelo para los EXCEL — la MISMA firma y el
 * MISMO contrato de siempre (solo los vuelos CON etiqueta). La usan la
 * columna «FACTURA VUELATOUR» del Libro Dinero (hoja 1 y «otros ingresos»),
 * «factura vuelatour» de «otros movimientos» del Balance y, desde el
 * 30-sep-2026, la hoja PRINCIPAL del balance por avión y del general
 * (`factura_vuelatour` por fila; allí pasa por el memo por vuelo
 * `AircraftBalanceService#etiquetasFacturaMemo`). Desde el 13-oct-2026 es
 * un envoltorio de `facturasDeVuelos`: los textos nuevos «Pendiente de
 * factura» / «No lleva factura» llegan a todos esos libros sin cambiar una
 * línea en ellos; un vuelo sin etiqueta (sin factura y SIN cobros) no entra
 * al mapa.
 */
export async function etiquetasFacturaDeVuelos(
  sb: SupabaseClient,
  vueloIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [id, f] of await facturasDeVuelos(sb, vueloIds)) {
    if (f.etiqueta) out.set(id, f.etiqueta);
  }
  return out;
}
