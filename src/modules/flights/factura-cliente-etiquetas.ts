import type { SupabaseClient } from '@supabase/supabase-js';
import { columnaOpcional } from '../../common/columna-opcional.util';
import { facturaEmitidaDisponible } from '../../common/factura-emitida-disponible.util';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  cuentasQueExigenFactura,
  origenesQueExigenFactura,
  vueloExigeFactura,
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
import {
  esSolicitudAutomatica,
  solicitudYaNoAplica,
  type CobroParaFactura,
  type VueloSolicitudRow,
} from './factura-solicitud.util';

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
  /** T.C. de la cotización: respaldo de `cobrosEnUsd` (0.0.77). */
  tc_usd_mxn?: unknown;
  factura_solicitada_at?: unknown;
  /** Nota de la solicitud: distingue la AUTOMÁTICA (0.0.77). */
  factura_solicitud_nota?: unknown;
};

type CobroFila = CobroParaFactura & { vuelo_id?: unknown };

/**
 * DETALLE de la factura de un vuelo (13-oct-2026, invariante 60): lo que la
 * columna pinta y lo que la solicitud automática y el pre-cierre necesitan
 * para decidir sin repetir la cascada.
 */
export interface FacturaDeVuelo {
  /** Pasos 1-4 de la cascada (CFDI vivo → emitidas → folio → estatus). */
  registrada: string | null;
  /**
   * Según TODOS los cobros del vuelo, neto de reembolsos por cuenta y moneda
   * (`vueloExigeFactura` con `cobrado` = `cobrosEnUsd(cobros,
   * vuelo.tc_usd_mxn)`: un anticipo devuelto completo, por cualquier vía, no
   * exige —decisión del cliente del 14-oct-2026—).
   */
  exigencia: ExigenciaFacturaVuelo;
  /**
   * Solicitud viva QUE CUENTA: manual (también en un CANCELADO que retuvo
   * dinero: es el único aviso) o automática mientras el vuelo exige (una
   * automática que ya no aplica NO pone «Pendiente de factura»; 14-oct-2026,
   * revisión F2); false sin la migración.
   */
  solicitada: boolean;
  /** `vuelo.estado` (null si el vuelo no existe). */
  estado: string | null;
  /** `cuentaDeCobroTexto` distintos de los cobros que exigen. */
  cuentas_exigen: string[];
  /** Lo que dice la columna «FACTURA VUELATOUR» (`etiquetaFacturaVuelo`). */
  etiqueta: string | null;
  /**
   * ADITIVOS (14-oct-2026, API 0.0.77, invariante 60), al final:
   * `origenes_exigen` = `origenesQueExigenFactura` («en HSBC Pesos» / «por
   * Transferencia»; el chip del panel); `solicitud_automatica` = solicitud
   * viva con la nota `PREFIJO_NOTA_SOLICITUD_AUTOMATICA`;
   * `solicitud_ya_no_aplica` = automática y el vuelo ya no exige
   * (`solicitudYaNoAplica`, sin mirar el estado del vuelo).
   */
  origenes_exigen: string[];
  solicitud_automatica: boolean;
  solicitud_ya_no_aplica: boolean;
  /**
   * SOLO con `{ conCobros: true }` (el aviso de transición de la solicitud
   * automática): las filas de `cobro_vuelo` leídas y el T.C. del vuelo
   * (respaldo de `cobrosEnUsd`). Sin la opción, las llaves no existen.
   */
  cobros?: CobroParaFactura[];
  tc_vuelo?: number | null;
}

/** Opciones INTERNAS del lector (sin ellas, el contrato de siempre). */
export interface OpcionesFacturasDeVuelos {
  /** Cada detalle trae además `cobros` y `tc_vuelo` (aviso de transición). */
  conCobros?: boolean;
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
      // `moneda` (revisión 13-oct-2026): la exigencia se decide por el NETO
      // de cada cuenta y moneda. `tc_usd_mxn` (14-oct-2026, API 0.0.77):
      // `cobrado` = `cobrosEnUsd` del vuelo, insumo de la regla 2 del
      // anticipo devuelto (devolución CRUZADA).
      .select(
        'id, vuelo_id, monto, moneda, tc_usd_mxn, cuenta_destino, metodo_cobro',
      )
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
 * factura» si en una cuenta que exige factura QUEDÓ dinero (neto de sus
 * reembolsos por moneda, `vueloExigeFactura`; revisión 13-oct-2026; un
 * anticipo devuelto completo, por cualquier vía, ya no exige: decisión del
 * cliente del 14-oct-2026) o si la solicitud cuenta (`solicitada`: manual
 * viva o automática mientras el vuelo exige); «No lleva factura» si hay
 * cobros y ninguno exige; `null` = SIN COBROS (desde ahora la celda vacía
 * significa «sin cobros», no «sin factura»).
 *
 * EN LOTE: 4 consultas por cada 200 vuelos — `factura` + columnas de `vuelo`
 * + `cobro_vuelo` (PAGINADA, nunca `.limit()`) y la cuarta al puente
 * `factura_emitida_vuelo` SOLO con la migración 20260924000003 aplicada —
 * nunca N+1. Desde el 0.0.77 el select de `vuelo` suma SIEMPRE
 * `tc_usd_mxn` (respaldo de `cobrosEnUsd`) y, con la sonda, la nota de la
 * solicitud; el de `cobro_vuelo`, `tc_usd_mxn` (sin consultas nuevas).
 *
 * Tolerante a las migraciones pendientes (`columnaOpcional`, re-sondeo ≤ 10
 * min): sin `20260923000001` se lee solo `facturado`; sin `20260924000001`
 * no se pide `factura_folio`; sin `20260924000003` no se consulta el
 * registro de emitidas ni se piden `factura_solicitada_at` /
 * `factura_solicitud_nota` (`solicitada: false`) — el Excel sale igual que
 * antes, jamás un 500. Cualquier OTRO error de lectura (en cualquiera de las
 * 4) se lanza (misma regla que el resto del libro: nunca un reporte con una
 * columna vacía en silencio).
 */
export async function facturasDeVuelos(
  sb: SupabaseClient,
  vueloIds: string[],
  opciones: OpcionesFacturasDeVuelos = {},
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
    'tc_usd_mxn',
    ...(conEmitidas ? ['factura_solicitada_at', 'factura_solicitud_nota'] : []),
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
    // `cobrado` por la fuente única `cobrosEnUsd` con el respaldo del T.C.
    // del vuelo (el mismo de `total_cobrado` del snapshot): insumo de la
    // regla 2 del anticipo devuelto (14-oct-2026).
    const tcVuelo = Number(v?.tc_usd_mxn) > 0 ? Number(v?.tc_usd_mxn) : null;
    const cobrado = cobrosEnUsd(cobros, tcVuelo);
    const exigencia = vueloExigeFactura(cobros, cobrado);
    const solicitud = solicitudDeFila(v);
    const yaNoAplica = solicitudYaNoAplica(solicitud, exigencia);
    // La solicitud CUENTA: viva y no una automática que ya no aplica. NO
    // hereda la exclusión de CANCELADO de `estadoSolicitud` (revisión F2):
    // una manual viva de un cancelado que retuvo dinero sigue diciendo
    // «Pendiente de factura» (la bandeja excluye cancelados: es el único aviso).
    const solicitada = solicitud.factura_solicitada_at != null && !yaNoAplica;
    out.set(id, {
      registrada: etiquetaFacturaRegistrada(base),
      exigencia,
      solicitada,
      estado: typeof v?.estado === 'string' ? v.estado : null,
      cuentas_exigen: cuentasQueExigenFactura(cobros, cobrado),
      etiqueta: etiquetaFacturaVuelo({ ...base, exigencia, solicitada }),
      origenes_exigen: origenesQueExigenFactura(cobros, cobrado),
      solicitud_automatica: esSolicitudAutomatica(solicitud),
      solicitud_ya_no_aplica: yaNoAplica,
      ...(opciones.conCobros === true
        ? {
            cobros: cobros.map((c) => ({ ...c })),
            tc_vuelo: tcVuelo,
          }
        : {}),
    });
  }
  return out;
}

/** Columnas de solicitud de la fila (texto no vacío o null). */
function solicitudDeFila(v: VueloFacturaFila | null): VueloSolicitudRow {
  const texto = (x: unknown): string | null =>
    typeof x === 'string' && x !== '' ? x : null;
  return {
    estado: typeof v?.estado === 'string' ? v.estado : null,
    factura_solicitada_at: texto(v?.factura_solicitada_at),
    factura_solicitud_nota: texto(v?.factura_solicitud_nota),
  };
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
