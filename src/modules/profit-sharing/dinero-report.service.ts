import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import { tuaEmbebidoDeGasto } from '../../common/desglose-gasto.util';
import { fetchRepartos } from '../../common/gasto-reparto.util';
import { particionIngresoVuelo } from '../../common/ingreso-vuelo.util';
import {
  PyservicesService,
  type DineroCombustibleFilaPayload,
  type DineroOtroGastoFilaPayload,
  type DineroOtroIngresoFilaPayload,
  type DineroUtilidadAvionPayload,
  type DineroVueloFilaPayload,
  type DineroXlsxPayload,
} from '../pyservices/pyservices.service';

function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function pos(v: unknown): number | null {
  const x = num(v);
  return x != null && x > 0 ? x : null;
}
function r2(x: number | null): number | null {
  return x == null ? null : Math.round(x * 100) / 100;
}
function r2n(x: number): number {
  return Math.round(x * 100) / 100;
}
function unwrapOne<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Libro "Dinero <periodo>": réplica del control manual del equipo (Excel
 * "Dinero Junio COMPLETO"). El sistema llena lo que SABE con sus fuentes
 * únicas — venta (cotización), cobros, facturas, otros ingresos (TUAs/extras/
 * pernocta del desglose canónico), otros gastos del mes e indirectos — y deja
 * VACÍAS, conservando su columna, las secciones sin regla definida todavía:
 * costo por hora del proveedor, comisiones y pagos a proveedor (el equipo
 * pasará esas reglas; no se inventan números).
 */
@Injectable()
export class DineroReportService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  async xlsx(
    desde: string,
    hasta: string,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(desde) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(hasta)
    ) {
      throw new BadRequestException('desde/hasta deben ser YYYY-MM-DD');
    }
    if (desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const payload = await this.buildPayload(desde, hasta);
    const buffer = await this.pyservices.generateDineroXlsx(payload);
    return { buffer, desde, hasta };
  }

  private async buildPayload(
    desde: string,
    hasta: string,
  ): Promise<DineroXlsxPayload> {
    const sb = this.supabase.service;
    const d1 = `${desde}T00:00:00-05:00`;
    const d2 = `${hasta}T23:59:59-05:00`;

    // Vuelos del periodo (todos los aviones). El libro manual solo registra
    // vuelos que ocurrieron o están en firme: las solicitudes/cotizaciones/
    // reservas que nunca se confirmaron NO son ventas (inflaban ventas y
    // "me deben", y descuadraban contra el reparto). Los CANCELADOS entran
    // SOLO si tienen dinero real ligado — cobros retenidos o gastos (regla
    // del cliente 28-ago-2026, misma que el reparto); los cancelados "en
    // seco" se filtran abajo, ya con cobros/gastos en mano, para no meter
    // ruido en la hoja.
    const vuelosRes = await sb
      .from('vuelo')
      .select(
        // subtotal/ajuste/comisión/iva_pct/tuas/extras/pernocta: insumos de
        // particionIngresoVuelo (venta del avión vs ingreso de VuelaTour).
        'id, folio, cliente_id, aeronave_id, estado, es_externo, fecha_vuelo, tiempo_cobrable_hr, tarifa_hora_usd, iva_usd, iva_pct, monto_total_usd, monto_total_mxn, tc_usd_mxn, cobrado, calculo_snapshot, subtotal_vuelo_usd, ajuste_final_usd, comision_vendedor_usd, tuas_usd, extras_total_usd, viaticos_pernocta_usd',
      )
      .in('estado', ['CONFIRMADO', 'EN_VUELO', 'COMPLETADO', 'CANCELADO'])
      .gte('fecha_vuelo', d1)
      .lte('fecha_vuelo', d2)
      .order('fecha_vuelo', { ascending: true });
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    const vuelosPeriodo = (vuelosRes.data ?? []) as Array<
      Record<string, unknown>
    >;
    const vueloIds = vuelosPeriodo.map((v) => v.id as string);

    const [
      aeronavesRes,
      clientesRes,
      escalasRes,
      cobrosRes,
      gastosVuelo,
      facturasRes,
      gastosSinVuelo,
      gastosGasRes,
    ] = await Promise.all([
      sb
        .from('aeronave')
        .select('id, matricula, modelo, color_calendario')
        .order('matricula'),
      sb.from('cliente').select('id, nombre'),
      vueloIds.length
        ? sb
            .from('escala')
            .select(
              'vuelo_id, orden, origen_iata, destino_iata, es_sobrevuelo, tipo_parada, pasajeros',
            )
            .in('vuelo_id', vueloIds)
            .is('cancelada_at', null)
            .order('orden', { ascending: true })
        : Promise.resolve({ data: [], error: null } as const),
      vueloIds.length
        ? sb
            .from('cobro_vuelo')
            .select('vuelo_id, monto, moneda, tc_usd_mxn, fecha_cobro')
            .in('vuelo_id', vueloIds)
            .order('fecha_cobro', { ascending: true })
        : Promise.resolve({ data: [], error: null } as const),
      vueloIds.length
        ? sb
            .from('gasto')
            .select(
              'vuelo_id, categoria, monto, propina, moneda, tc_gasto, fecha_gasto, valor_ia_extraido',
            )
            .in('vuelo_id', vueloIds)
        : Promise.resolve({ data: [], error: null } as const),
      vueloIds.length
        ? sb
            .from('factura')
            .select('vuelo_id, serie, folio, estado')
            .in('vuelo_id', vueloIds)
            .neq('estado', 'CANCELADA')
        : Promise.resolve({ data: [], error: null } as const),
      // "Otros gastos" del mes: sin vuelo (pensión, cera, nómina, etc.).
      // fecha_gasto es DATE: comparación de días, sin componente horaria.
      sb
        .from('gasto')
        .select(
          'id, categoria, monto, moneda, tc_gasto, fecha_gasto, notas, aeronave_id, proveedor:proveedor_id(nombre)',
        )
        .is('vuelo_id', null)
        // PERSONAL_DUENO fuera: es gasto personal del dueño, no del mes de
        // la empresa (réplica del Excel del cliente).
        .neq('categoria', 'PERSONAL_DUENO')
        .gte('fecha_gasto', desde)
        .lte('fecha_gasto', hasta)
        .order('fecha_gasto', { ascending: true }),
      // COMBUSTIBLE del mes (pestaña propia, 26-ago-2026): TODO el gas del
      // periodo por fecha_gasto, con o sin vuelo — mismo eje que el reparto.
      sb
        .from('gasto')
        .select(
          'categoria, monto, litros, moneda, tc_gasto, fecha_gasto, lugar, notas, aeronave_id, proveedor:proveedor_id(nombre)',
        )
        .eq('categoria', 'GAS')
        .gte('fecha_gasto', desde)
        .lte('fecha_gasto', hasta)
        .order('fecha_gasto', { ascending: true }),
    ]);
    for (const r of [
      aeronavesRes,
      clientesRes,
      escalasRes,
      cobrosRes,
      gastosVuelo,
      facturasRes,
      gastosSinVuelo,
      gastosGasRes,
    ]) {
      if (r.error) throw new Error(r.error.message);
    }

    const aviones = new Map(
      (aeronavesRes.data ?? []).map((a) => [
        a.id as string,
        {
          matricula: a.matricula as string,
          modelo: (a.modelo as string) ?? '',
          color: (a.color_calendario as string | null) ?? null,
        },
      ]),
    );
    const clientes = new Map(
      (clientesRes.data ?? []).map((c) => [c.id as string, c.nombre as string]),
    );
    const escalasPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const e of (escalasRes.data ?? []) as Array<Record<string, unknown>>) {
      const vid = e.vuelo_id as string;
      (escalasPorVuelo.get(vid) ?? escalasPorVuelo.set(vid, []).get(vid)!).push(
        e,
      );
    }
    const cobrosPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const c of (cobrosRes.data ?? []) as Array<Record<string, unknown>>) {
      const vid = c.vuelo_id as string;
      (cobrosPorVuelo.get(vid) ?? cobrosPorVuelo.set(vid, []).get(vid)!).push(
        c,
      );
    }
    const gastosPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const g of (gastosVuelo.data ?? []) as Array<
      Record<string, unknown>
    >) {
      const vid = g.vuelo_id as string;
      (gastosPorVuelo.get(vid) ?? gastosPorVuelo.set(vid, []).get(vid)!).push(
        g,
      );
    }
    const facturaPorVuelo = new Map<string, string>();
    for (const f of (facturasRes.data ?? []) as Array<
      Record<string, unknown>
    >) {
      const vid = f.vuelo_id as string;
      if (!vid || facturaPorVuelo.has(vid)) continue;
      const etiqueta = [f.serie, f.folio].filter(Boolean).join('-');
      if (etiqueta) facturaPorVuelo.set(vid, etiqueta);
    }
    // Cancelados sin cobros ni gastos: fuera (ver arriba). Un cancelado con
    // dinero se queda y su fila se arma con reglas propias (abajo).
    const vuelos = vuelosPeriodo.filter(
      (v) =>
        v.estado !== 'CANCELADO' ||
        cobrosPorVuelo.has(v.id as string) ||
        gastosPorVuelo.has(v.id as string),
    );

    // CLAVE del libro: "vt" + primer nombre del cliente en minúsculas
    // (vtchacon, vtmagaña). Vuelo de SERVICIO (tramo de taller sin pax) →
    // "vtservicio", como en el libro manual.
    const claveDe = (v: Record<string, unknown>): string => {
      const escalas = escalasPorVuelo.get(v.id as string) ?? [];
      const esServicio =
        escalas.length > 0 &&
        escalas.some((e) => e.tipo_parada === 'SERVICIO') &&
        escalas.every((e) => !(Number(e.pasajeros) > 0));
      if (esServicio) return 'vtservicio';
      const nombre = clientes.get(v.cliente_id as string) ?? '';
      const primera = nombre.trim().split(/\s+/)[0] ?? '';
      const limpia = primera.toLowerCase().replace(/[^a-záéíóúüñ0-9]/gi, '');
      return limpia ? `vt${limpia.toLowerCase()}` : 'vt';
    };

    const rutaDe = (vueloId: string): string => {
      const legs = escalasPorVuelo.get(vueloId) ?? [];
      if (legs.length === 0) return '';
      const tokens: string[] = [];
      for (const l of legs) {
        const o = String(l.origen_iata ?? '');
        const d = String(l.destino_iata ?? '');
        if (tokens.length === 0 || tokens[tokens.length - 1] !== o)
          tokens.push(o);
        if (l.es_sobrevuelo === true) tokens.push('sobrevuelo');
        tokens.push(d);
      }
      return tokens.join('-').toLowerCase();
    };

    // ===== Hoja 1: dinero-vlos =====
    const filas: DineroVueloFilaPayload[] = [];
    const otrosIngresos: DineroOtroIngresoFilaPayload[] = [];
    let sumaTc = 0;
    let nTc = 0;
    for (const v of vuelos) {
      const avion = aviones.get(v.aeronave_id as string);
      // VUELO CANCELADO con dinero (regla del cliente, 28-ago-2026): la
      // "venta" es lo COBRADO y no reembolsado (cargo por cancelación /
      // anticipo retenido, fuente única cobrosEnUsd), no la cotización; no
      // hay tiempo ni tarifa por hora (el servicio no se prestó), el IVA se
      // deriva de lo retenido con el iva_pct del vuelo, la cotización queda
      // solo informativa en total_cliente_* y "me deben" es 0 (ya no es una
      // cuenta por cobrar). Misma regla que el reparto.
      const esCancelado = v.estado === 'CANCELADO';
      const horas = esCancelado ? null : num(v.tiempo_cobrable_hr);
      const tarifa = esCancelado ? null : num(v.tarifa_hora_usd);
      const totalUsd = num(v.monto_total_usd);
      const totalMxn = num(v.monto_total_mxn);
      // REGLA 6 (cliente, 28-ago-2026): las columnas de VENTA de esta hoja
      // son la venta del AVIÓN (tiempo + ajuste + comisión del vendedor + su
      // IVA). TUAS/extras/pernocta y su IVA son ingreso de VuelaTour y viven
      // en la hoja "otros ingresos". Partición = fuente única
      // (particionIngresoVuelo). El total del CLIENTE se conserva en
      // total_cliente_* y "me deben" sigue sobre ese total (la deuda del
      // cliente es completa).
      const p = particionIngresoVuelo(v);
      const conPrecio = !esCancelado && p.total_usd > 0;
      // TC de venta: el pactado; si no, derivado del total MXN por composición.
      const tc =
        pos(v.tc_usd_mxn) ??
        (totalMxn != null && totalUsd != null && totalUsd > 0
          ? totalMxn / totalUsd
          : null);
      // Lo retenido en USD (solo cancelados; los MXN sin TC quedan fuera del
      // monto, como en todo el sistema, pero se ven en la lista de cobros).
      const retenidoUsd = esCancelado
        ? cobrosEnUsd(cobrosPorVuelo.get(v.id as string) ?? [], tc).total_usd
        : null;
      // IVA retenido: iva_pct del vuelo (fracción 0.16 o porcentaje 16); sin
      // IVA en la cotización, nada que derivar.
      const ivaPctCrudo = num(v.iva_pct);
      const ivaFrac =
        ivaPctCrudo != null && ivaPctCrudo > 0
          ? ivaPctCrudo > 1
            ? ivaPctCrudo / 100
            : ivaPctCrudo
          : null;
      // Sin precio (cliente interno / $0): como siempre, columnas crudas.
      const ventaUsd =
        retenidoUsd != null ? retenidoUsd : conPrecio ? p.avion_usd : totalUsd;
      const ivaUsd =
        retenidoUsd != null
          ? ivaFrac != null
            ? r2n(retenidoUsd - retenidoUsd / (1 + ivaFrac))
            : null
          : conPrecio
            ? p.iva_avion_usd
            : num(v.iva_usd);
      if (tc != null) {
        sumaTc += tc;
        nTc += 1;
      }
      // IVA × hr SOLO con el IVA del avión: antes entraba el IVA de TUAS/
      // extras y la columna salía inflada respecto a la tarifa.
      const ivaHr =
        ivaUsd != null && horas != null && horas > 0 ? ivaUsd / horas : null;
      // Total del CLIENTE en MXN: misma conversión de siempre (persistido
      // por composición; si no, total × TC).
      const totalMxnCalc =
        totalMxn ?? (totalUsd != null && tc != null ? totalUsd * tc : null);
      // Venta del avión en MXN con el MISMO TC. Sin parte VuelaTour el avión
      // ES el total del cliente (idéntico a antes, al centavo). Cancelado: lo
      // retenido × TC (sin TC no se inventa).
      const ventaMxn =
        retenidoUsd != null
          ? tc != null
            ? r2n(retenidoUsd * tc)
            : null
          : conPrecio && p.vuelatour_usd > 0
            ? tc != null
              ? r2n(p.avion_usd * tc)
              : null
            : totalMxnCalc;
      const ivaMxn = ivaUsd != null && tc != null ? ivaUsd * tc : null;

      // Cobros a MXN (misma regla del balance: MXN directo; USD × su TC o el
      // TC de venta; sin TC no se suma en falso — se omite la parcialidad).
      const cobros = (cobrosPorVuelo.get(v.id as string) ?? []).map((c) => {
        const monto = num(c.monto) ?? 0;
        const mxn =
          c.moneda === 'MXN'
            ? monto
            : (pos(c.tc_usd_mxn) ?? tc) != null
              ? monto * (pos(c.tc_usd_mxn) ?? tc)!
              : null;
        return { fecha: (c.fecha_cobro as string) ?? null, monto_mxn: r2(mxn) };
      });
      const totalCobros = cobros.reduce((s, c) => s + (c.monto_mxn ?? 0), 0);
      // Cancelado: nada por cobrar (lo retenido ES la venta).
      const meDeben = esCancelado
        ? 0
        : totalMxnCalc != null
          ? Math.max(0, totalMxnCalc - totalCobros)
          : null;
      // El schema no tiene columna de estado: el cancelado se marca en la
      // RUTA (columna de texto que ya pinta la hoja) y en el status de cobro.
      const rutaBase = rutaDe(v.id as string);
      const ruta = esCancelado
        ? rutaBase
          ? `${rutaBase} · CANCELADO`
          : 'CANCELADO'
        : rutaBase;

      filas.push({
        clave: claveDe(v),
        matricula: avion?.matricula ?? (v.es_externo ? 'EXTERNO' : null),
        color: avion?.color ?? null,
        fecha: (v.fecha_vuelo as string) ?? null,
        ruta,
        tiempo: horas,
        venta_hr_usd: r2(tarifa),
        venta_hr_mxn: r2(tarifa != null && tc != null ? tarifa * tc : null),
        iva_hr_usd: r2(ivaHr),
        venta_hr_masiva_usd: r2(tarifa != null ? tarifa + (ivaHr ?? 0) : null),
        // Venta del AVIÓN (regla 6); el total del cliente va aparte.
        total_cobrado_usd: r2(ventaUsd),
        iva_total_usd: r2(ivaUsd),
        tc_venta: tc != null ? Math.round(tc * 10000) / 10000 : null,
        total_cobrado_mxn: r2(ventaMxn),
        iva_total_mxn: r2(ivaMxn),
        total_siva_mxn: r2(ventaMxn != null ? ventaMxn - (ivaMxn ?? 0) : null),
        // Cancelado: la cotización se conserva aquí solo como referencia.
        total_cliente_usd: r2(conPrecio ? p.total_usd : totalUsd),
        total_cliente_mxn: r2(totalMxnCalc),
        status_cobro: esCancelado
          ? 'CANCELADO'
          : v.cobrado === true
            ? 'COBRADO'
            : 'PENDIENTE',
        cobros,
        total_cobros_mxn: r2(totalCobros),
        me_deben_mxn: r2(meDeben),
        factura_vuelatour: facturaPorVuelo.get(v.id as string) ?? null,
      });

      // ===== Hoja 2: otros ingresos (TUAs/extras/pernocta + su IVA = la
      // parte VuelaTour de la partición, en MXN con el TC de venta). El
      // egreso solo se llena cuando el mapeo es directo (TUAS ↔ gasto TUAS
      // del vuelo); el resto lo concilia el equipo a mano, como en su libro.
      //
      // Líneas PRE-IVA: del desglose canónico v1.3 cuando existe (una línea
      // TUAS por aeropuerto, extras, pernocta); sin snapshot, de las columnas
      // del vuelo (misma fuente que la partición). Partición INCONSISTENTE
      // (desglose que no cuadra: todo al avión) → SIN líneas: la hoja 1 ya
      // lleva el total completo y repetirlas contaría doble en utilidades;
      // el pre-cierre lo avisa (extras_sin_desglose). El TUA PAGADO del vuelo
      // sale de todos modos (fila de solo-egreso, abajo).
      const lineasVT: Array<{
        clave: string;
        concepto: string;
        monto_usd: number;
      }> = [];
      if (conPrecio && p.vuelatour_usd > 0) {
        if (p.fuente === 'desglose') {
          const snapshot = v.calculo_snapshot as {
            desglose?: {
              clave?: string;
              concepto?: string;
              monto_usd?: number;
            }[];
          } | null;
          for (const linea of snapshot?.desglose ?? []) {
            const claveLinea = String(linea.clave ?? '');
            if (!/^(TUAS|EXTRA|PERNOCTA)/.test(claveLinea)) continue;
            const montoUsd = num(linea.monto_usd);
            if (montoUsd == null || montoUsd === 0) continue;
            lineasVT.push({
              clave: claveLinea,
              concepto: String(linea.concepto ?? claveLinea).toLowerCase(),
              monto_usd: montoUsd,
            });
          }
        } else {
          for (const [clave, concepto, montoUsd] of [
            ['TUAS', 'tuas', p.tuas_usd],
            ['EXTRA', 'extras', p.extras_usd],
            ['PERNOCTA', 'pernocta', p.pernocta_usd],
          ] as const) {
            if (montoUsd !== 0)
              lineasVT.push({ clave, concepto, monto_usd: montoUsd });
          }
        }
      }
      const gastosV = gastosPorVuelo.get(v.id as string) ?? [];
      // TUA PAGADO del vuelo (categoría TUAS entera + parte TUA EMBEBIDA en
      // facturas de aeródromo leídas por IA — caso ASUR "aterrizaje,
      // pernocta, TUA y plataforma"), calculado UNA vez por vuelo, a MXN con
      // la MISMA regla del Balance general: MXN directo; USD × tc_gasto o,
      // sin él, el TC de venta; sin NINGÚN TC no se suma en falso — queda
      // como nota en el concepto. FUENTE ÚNICA `tuaEmbebidoDeGasto`: misma
      // regla y exclusiones (CATS_SIN_TUA_EMBEBIDO) que el reparto y el
      // Balance por avión — antes cada lector traía su propia lista y los
      // números divergían. Se aparea a la PRIMERA línea TUAS cobrada; si el
      // vuelo no lleva línea TUAS (partición inconsistente, cotizado sin
      // TUAS, TUA que apareció en la factura del aeródromo…) sale al final
      // del vuelo como fila de SOLO-egreso — antes desaparecía de la hoja.
      // Vuelo CANCELADO: sin líneas de ingreso (conPrecio=false: no se
      // vendió TUAS/extras/pernocta); el TUA que sí se pagó sale igual como
      // solo-egreso.
      let tuaPagadoMxn = 0;
      let tuaPagadoHubo = false;
      let tuaSinTc = false;
      let fechaTua: string | null = null;
      for (const g of gastosV) {
        const monto = num(g.monto) ?? 0;
        const parte =
          g.categoria === 'TUAS'
            ? monto
            : tuaEmbebidoDeGasto({
                vuelo_id: g.vuelo_id as string | null,
                categoria: g.categoria as string | null,
                monto: g.monto as string | number | null,
                propina: g.propina as string | number | null,
                valor_ia_extraido: g.valor_ia_extraido,
              });
        if (parte <= 0) continue;
        const tcg = pos(g.tc_gasto) ?? tc;
        const parteMxn =
          g.moneda === 'MXN' ? parte : tcg != null ? parte * tcg : null;
        if (parteMxn == null) {
          // USD sin ningún TC: rastro en el concepto, jamás sumado en falso.
          tuaSinTc = true;
          continue;
        }
        if (parteMxn <= 0) continue;
        tuaPagadoMxn += parteMxn;
        tuaPagadoHubo = true;
        fechaTua ??= (g.fecha_gasto as string) ?? null;
      }
      const conceptoTuasPagadas = (extra?: string): string => {
        const notas = [
          tuaSinTc
            ? tuaPagadoHubo
              ? 'parcial: USD sin TC'
              : 'USD sin TC'
            : null,
          extra ?? null,
        ].filter(Boolean);
        return notas.length
          ? `tuas pagadas (${notas.join('; ')})`
          : 'tuas pagadas';
      };
      // El desglose canónico emite UNA línea TUAS POR AEROPUERTO: el egreso
      // (lo pagado) se adjunta SOLO a la primera — repetirlo en cada línea
      // duplicaba el total de la columna egreso de la hoja.
      let egresoTuasAsignado = false;
      let sumaPreIvaMxn = 0;
      // Última línea pre-IVA del vuelo: absorbe el residuo cambiario del
      // cierre (ver abajo) en vez de inventar una fila de ±0.01.
      let ultimaLineaVT: DineroOtroIngresoFilaPayload | null = null;
      for (const linea of lineasVT) {
        const claveLinea = linea.clave;
        const montoUsd = linea.monto_usd;
        const ingresoMxn = tc != null ? r2(montoUsd * tc) : null;
        let egresoMxn: number | null = null;
        let conceptoEgreso: string | null = null;
        let fechaEgreso: string | null = null;
        // TUA cobrado ↔ TUA pagado (pre-calculado arriba).
        if (
          claveLinea === 'TUAS' &&
          !egresoTuasAsignado &&
          (tuaPagadoHubo || tuaSinTc)
        ) {
          egresoMxn = tuaPagadoHubo ? r2(tuaPagadoMxn) : null;
          conceptoEgreso = conceptoTuasPagadas();
          fechaEgreso = fechaTua;
          egresoTuasAsignado = true;
        }
        if (ingresoMxn != null) sumaPreIvaMxn += ingresoMxn;
        const filaVT: DineroOtroIngresoFilaPayload = {
          clave: claveDe(v),
          fecha_vuelo: (v.fecha_vuelo as string) ?? null,
          concepto_egreso: conceptoEgreso,
          egreso_mxn: egresoMxn,
          fecha_egreso: fechaEgreso,
          concepto_ingreso: linea.concepto,
          ingreso_mxn: ingresoMxn,
          fecha_ingreso: (v.fecha_vuelo as string) ?? null,
          remanente_mxn:
            ingresoMxn != null ? r2(ingresoMxn - (egresoMxn ?? 0)) : null,
          factura: facturaPorVuelo.get(v.id as string) ?? null,
        };
        otrosIngresos.push(filaVT);
        if (ingresoMxn != null) ultimaLineaVT = filaVT;
      }
      // CIERRE por vuelo: la parte VuelaTour en MXN (= total del cliente −
      // venta del avión) debe ser Σ líneas pre-IVA + IVA de TUAS/extras/
      // pernocta, así por vuelo y en la hoja completa Σ venta avión +
      // Σ otros ingresos == Σ total cliente AL CENTAVO (fiabilidad numérica
      // del libro). El IVA sale de la partición (iva_vuelatour_usd × TC) como
      // línea propia; el RESIDUO cambiario (Σ round2 por línea ≠ round2 del
      // total, típicamente ±0.01) se absorbe en la última línea pre-IVA del
      // vuelo — antes se mezclaba con el IVA y salían filas "iva de tuas/
      // extras" de −0.01.
      if (
        conPrecio &&
        p.vuelatour_usd > 0 &&
        tc != null &&
        totalMxnCalc != null &&
        ventaMxn != null
      ) {
        const vtMxn = r2n(r2n(totalMxnCalc) - ventaMxn);
        const cierre = r2n(vtMxn - sumaPreIvaMxn);
        let ivaVtMxn =
          p.iva_vuelatour_usd > 0 ? r2n(p.iva_vuelatour_usd * tc) : 0;
        const residuo = r2n(cierre - ivaVtMxn);
        if (residuo !== 0) {
          if (ultimaLineaVT != null && ultimaLineaVT.ingreso_mxn != null) {
            ultimaLineaVT.ingreso_mxn = r2n(
              ultimaLineaVT.ingreso_mxn + residuo,
            );
            ultimaLineaVT.remanente_mxn = r2n(
              ultimaLineaVT.ingreso_mxn - (ultimaLineaVT.egreso_mxn ?? 0),
            );
          } else {
            // Sin línea pre-IVA (no debería pasar): el residuo viaja con el
            // IVA para no perder el cuadre.
            ivaVtMxn = r2n(ivaVtMxn + residuo);
          }
        }
        if (ivaVtMxn !== 0) {
          otrosIngresos.push({
            clave: claveDe(v),
            fecha_vuelo: (v.fecha_vuelo as string) ?? null,
            concepto_egreso: null,
            egreso_mxn: null,
            fecha_egreso: null,
            concepto_ingreso: 'iva de tuas/extras',
            ingreso_mxn: ivaVtMxn,
            fecha_ingreso: (v.fecha_vuelo as string) ?? null,
            remanente_mxn: ivaVtMxn,
            factura: facturaPorVuelo.get(v.id as string) ?? null,
          });
        }
      }

      // TUA pagado SIN línea TUAS cobrada (partición inconsistente, vuelo
      // cotizado sin TUAS, TUA que apareció en la factura del aeródromo…):
      // fila de SOLO-egreso, misma estrategia que el Balance general — el
      // pago existe aunque no se haya trasladado al cliente. Ingreso null:
      // `totalOtrosIngresos` (utilidades) no cambia; el total de egresos de
      // la hoja sí lo recoge.
      if ((tuaPagadoHubo || tuaSinTc) && !egresoTuasAsignado) {
        const egreso = tuaPagadoHubo ? r2(tuaPagadoMxn) : null;
        otrosIngresos.push({
          clave: claveDe(v),
          fecha_vuelo: (v.fecha_vuelo as string) ?? null,
          concepto_egreso: conceptoTuasPagadas(
            esCancelado ? 'vuelo cancelado' : 'sin línea TUAS cobrada',
          ),
          egreso_mxn: egreso,
          fecha_egreso: fechaTua,
          concepto_ingreso: null,
          ingreso_mxn: null,
          fecha_ingreso: null,
          remanente_mxn: egreso != null ? r2(-egreso) : null,
          factura: facturaPorVuelo.get(v.id as string) ?? null,
        });
      }
    }

    // ===== Hoja 3: otros gastos del mes (sin vuelo), con acumulado =====
    // Reparto MANUAL (gasto_reparto, 26-ago-2026): la FILA del libro y el
    // acumulado NO cambian (el pago es uno); solo la ATRIBUCIÓN por avión de
    // la hoja utilidades usa los parciales — el remanente queda en el
    // acumulado general (gasto de la EMPRESA VuelaTour), sin acreditarse a
    // ningún avión. Misma regla que el reparto a socios y el balance.
    const repartosDinero = await fetchRepartos(
      sb,
      ((gastosSinVuelo.data ?? []) as Array<Record<string, unknown>>).map(
        (g) => g.id as string,
      ),
    );
    const otrosGastos: DineroOtroGastoFilaPayload[] = [];
    let acumulado = 0;
    const indirectosPorAvion = new Map<string, number>();
    const otrosPorAvion = new Map<string, number>();
    const permisosPorAvion = new Map<string, number>();
    for (const g of (gastosSinVuelo.data ?? []) as Array<
      Record<string, unknown>
    >) {
      // GAS fuera de "otros gastos" (26-ago-2026): el combustible tiene su
      // pestaña propia — dejarlo aquí lo contaría DOS veces en utilidades.
      if (g.categoria === 'GAS') continue;
      // TUA pagado SIN vuelo (regla 7, 28-ago-2026): no es costo del avión
      // ni del mes — es un traslado al pasajero cuyo egreso vive en Otros
      // movimientos del Balance general. Se LISTA (el dinero no se esconde)
      // pero no suma al acumulado ni se acredita a ningún avión en
      // utilidades. Los TUAS con vuelo ya se aparean en "otros ingresos".
      const esTuas = g.categoria === 'TUAS';
      const monto = num(g.monto) ?? 0;
      const tcg = pos(g.tc_gasto);
      const mxn = g.moneda === 'MXN' ? monto : tcg != null ? monto * tcg : null;
      const prov = unwrapOne(g.proveedor as { nombre?: string } | null)?.nombre;
      const nota = ((g.notas as string | null) ?? '').split('\n')[0].trim();
      const filasReparto = repartosDinero.get(g.id as string);
      const concepto = [
        String(g.categoria ?? '').toLowerCase(),
        prov ?? null,
        nota || null,
        filasReparto
          ? `repartido entre ${filasReparto.length} avión(es)`
          : null,
        mxn == null ? '(USD sin TC — no suma)' : null,
        esTuas ? '(TUA pagado — no resta: Otros movimientos)' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (mxn != null && !esTuas) acumulado += mxn;
      otrosGastos.push({
        fecha: (g.fecha_gasto as string) ?? null,
        concepto,
        monto_mxn: r2(mxn),
        acumulado_mxn: r2(acumulado),
      });
      // Cortes por avión para la hoja utilidades: clasificación por ORIGEN
      // (regla 8, 28-ago-2026 — la MISMA del Balance por avión, antes era
      // solo por categoría y los cortes no cuadraban con el balance):
      //  - PERMISO → permisos (con o sin reparto).
      //  - Parcial de un reparto MANUAL (FIJO/OTRO/INDIRECTO/GASOLINA/
      //    VISITA de la empresa repartidos a mano) → otros gastos: la parte
      //    de este avión de un gasto administrativo.
      //  - aeronave_id DIRECTO sin vuelo (INDIRECTO, REFACCION, OTRO, FIJO,
      //    OPERACIONES, …) → gastos indirectos: no se ligan a un vuelo pero
      //    sí al avión.
      //  - GAS (pestaña propia) y TUAS (regla 7) nunca se acreditan.
      // Con reparto manual los PARCIALES mandan (aeronave_id del gasto se
      // ignora — regla binaria); cada parcial convierte con la MISMA regla
      // del padre (moneda + tc_gasto): sin TC no se acredita (ya está en el
      // aviso del libro).
      const acreditar = (aid: string, monto_: number, parcial: boolean) => {
        const destino =
          g.categoria === 'PERMISO'
            ? permisosPorAvion
            : parcial
              ? otrosPorAvion
              : indirectosPorAvion;
        destino.set(aid, (destino.get(aid) ?? 0) + monto_);
      };
      if (esTuas) {
        // Regla 7: nunca se acredita a un avión (ver arriba).
      } else if (filasReparto && filasReparto.length > 0) {
        for (const r of filasReparto) {
          const mxnParcial =
            g.moneda === 'MXN' ? r.monto : tcg != null ? r.monto * tcg : null;
          if (mxnParcial != null) acreditar(r.aeronave_id, mxnParcial, true);
        }
      } else {
        const aid = g.aeronave_id as string | null;
        if (aid && mxn != null) acreditar(aid, mxn, false);
      }
    }

    // ===== Pestaña COMBUSTIBLE (26-ago-2026): el gas del mes por avión =====
    // Con o sin vuelo, eje fecha_gasto — mismo filtro crudo por aeronave_id
    // que el reparto. Las cargas SIN avión se listan (el dinero jamás
    // desaparece) marcadas para asignarles aeronave.
    const combustibleFilas: DineroCombustibleFilaPayload[] = [];
    const combustiblePorAvion = new Map<string, number>();
    let combustibleAcum = 0;
    let combustibleLitros = 0;
    let combustibleSinAvion = 0;
    for (const g of (gastosGasRes.data ?? []) as Array<
      Record<string, unknown>
    >) {
      const monto = num(g.monto) ?? 0;
      const tcg = pos(g.tc_gasto);
      const mxn = g.moneda === 'MXN' ? monto : tcg != null ? monto * tcg : null;
      const prov = unwrapOne(g.proveedor as { nombre?: string } | null)?.nombre;
      const nota = ((g.notas as string | null) ?? '').split('\n')[0].trim();
      const aid = g.aeronave_id as string | null;
      const avion = aid ? aviones.get(aid) : undefined;
      const litros = pos(g.litros);
      const concepto = [
        (g.lugar as string | null) || null,
        prov ?? null,
        nota || null,
        mxn == null ? '(USD sin TC — no suma)' : null,
        !aid ? 'SIN AVIÓN — asignar aeronave en Combustibles' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (mxn != null) combustibleAcum += mxn;
      if (litros != null) combustibleLitros += litros;
      if (!aid) combustibleSinAvion += 1;
      combustibleFilas.push({
        fecha: (g.fecha_gasto as string) ?? null,
        matricula: avion?.matricula ?? '—',
        avion_color: avion?.color ?? null,
        concepto,
        litros: r2(litros),
        monto_mxn: r2(mxn),
        acumulado_mxn: r2(combustibleAcum),
      });
      if (aid && mxn != null) {
        combustiblePorAvion.set(aid, (combustiblePorAvion.get(aid) ?? 0) + mxn);
      }
    }

    // ===== Hoja 4: utilidades (lo computable hoy) =====
    const utilidadesAviones: DineroUtilidadAvionPayload[] = [];
    for (const [id, a] of aviones) {
      const ind = indirectosPorAvion.get(id);
      const otr = otrosPorAvion.get(id);
      const per = permisosPorAvion.get(id);
      const comb = combustiblePorAvion.get(id);
      if (ind == null && otr == null && per == null && comb == null) continue;
      utilidadesAviones.push({
        matricula: a.matricula,
        gastos_indirectos_mxn: r2(ind ?? null),
        otros_gastos_mxn: r2(otr ?? null),
        permisos_mxn: r2(per ?? null),
        combustible_mxn: r2(comb ?? null),
      });
    }
    // Solo INGRESOS (las filas de solo-egreso — TUA pagado sin línea TUAS —
    // llevan ingreso null y no entran): es lo que resta/suma en utilidades.
    const totalOtrosIngresos = otrosIngresos.reduce(
      (s, f) => s + (f.ingreso_mxn ?? 0),
      0,
    );

    return {
      periodo_desde: desde,
      periodo_hasta: hasta,
      generado: new Date().toISOString(),
      leyenda_colores: [...aviones.values()].map((a) => ({
        matricula: a.matricula,
        modelo: a.modelo,
        color: a.color,
      })),
      vuelos: filas,
      otros_ingresos: otrosIngresos,
      otros_gastos: otrosGastos,
      combustible: combustibleFilas,
      combustible_total_mxn: r2(combustibleAcum),
      combustible_litros: r2(combustibleLitros),
      combustible_precio_litro:
        combustibleLitros > 0 && combustibleAcum > 0
          ? r2(combustibleAcum / combustibleLitros)
          : null,
      combustible_sin_avion: combustibleSinAvion,
      // "Gasto de combustible" del mes: resta en la hoja utilidades (incluye
      // las cargas sin avión — el dinero no se esconde mientras se asignan).
      utilidades_combustible_mxn: r2(combustibleAcum),
      utilidades_otros_ingresos_mxn: r2(totalOtrosIngresos),
      utilidades_otros_gastos_mxn: r2(acumulado),
      utilidades_tc:
        nTc > 0 ? Math.round((sumaTc / nTc) * 10000) / 10000 : null,
      utilidades_aviones: utilidadesAviones,
    };
  }
}
