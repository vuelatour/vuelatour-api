import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { desgloseGastoPartes } from '../../common/desglose-gasto.util';
import { fetchRepartos } from '../../common/gasto-reparto.util';
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
    // "me deben", y descuadraban contra el reparto, que solo usa COMPLETADO).
    const vuelosRes = await sb
      .from('vuelo')
      .select(
        'id, folio, cliente_id, aeronave_id, estado, es_externo, fecha_vuelo, tiempo_cobrable_hr, tarifa_hora_usd, iva_usd, monto_total_usd, monto_total_mxn, tc_usd_mxn, cobrado, calculo_snapshot',
      )
      .in('estado', ['CONFIRMADO', 'EN_VUELO', 'COMPLETADO'])
      .gte('fecha_vuelo', d1)
      .lte('fecha_vuelo', d2)
      .order('fecha_vuelo', { ascending: true });
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    const vuelos = (vuelosRes.data ?? []) as Array<Record<string, unknown>>;
    const vueloIds = vuelos.map((v) => v.id as string);

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
      const horas = num(v.tiempo_cobrable_hr);
      const tarifa = num(v.tarifa_hora_usd);
      const ivaUsd = num(v.iva_usd);
      const totalUsd = num(v.monto_total_usd);
      const totalMxn = num(v.monto_total_mxn);
      // TC de venta: el pactado; si no, derivado del total MXN por composición.
      const tc =
        pos(v.tc_usd_mxn) ??
        (totalMxn != null && totalUsd != null && totalUsd > 0
          ? totalMxn / totalUsd
          : null);
      if (tc != null) {
        sumaTc += tc;
        nTc += 1;
      }
      const ivaHr =
        ivaUsd != null && horas != null && horas > 0 ? ivaUsd / horas : null;
      const totalMxnCalc =
        totalMxn ?? (totalUsd != null && tc != null ? totalUsd * tc : null);
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
      const meDeben =
        totalMxnCalc != null ? Math.max(0, totalMxnCalc - totalCobros) : null;

      filas.push({
        clave: claveDe(v),
        matricula: avion?.matricula ?? (v.es_externo ? 'EXTERNO' : null),
        color: avion?.color ?? null,
        fecha: (v.fecha_vuelo as string) ?? null,
        ruta: rutaDe(v.id as string),
        tiempo: horas,
        venta_hr_usd: r2(tarifa),
        venta_hr_mxn: r2(tarifa != null && tc != null ? tarifa * tc : null),
        iva_hr_usd: r2(ivaHr),
        venta_hr_masiva_usd: r2(tarifa != null ? tarifa + (ivaHr ?? 0) : null),
        total_cobrado_usd: r2(totalUsd),
        iva_total_usd: r2(ivaUsd),
        tc_venta: tc != null ? Math.round(tc * 10000) / 10000 : null,
        total_cobrado_mxn: r2(totalMxnCalc),
        iva_total_mxn: r2(ivaMxn),
        total_siva_mxn: r2(
          totalMxnCalc != null ? totalMxnCalc - (ivaMxn ?? 0) : null,
        ),
        status_cobro: v.cobrado === true ? 'COBRADO' : 'PENDIENTE',
        cobros,
        total_cobros_mxn: r2(totalCobros),
        me_deben_mxn: r2(meDeben),
        factura_vuelatour: facturaPorVuelo.get(v.id as string) ?? null,
      });

      // ===== Hoja 2: otros ingresos (TUAs/extras/pernocta del desglose
      // canónico v1.3, en MXN con el TC de venta). El egreso solo se llena
      // cuando el mapeo es directo (TUAS ↔ gasto TUAS del vuelo); el resto lo
      // concilia el equipo a mano, como en su libro.
      const snapshot = v.calculo_snapshot as {
        desglose?: { clave?: string; concepto?: string; monto_usd?: number }[];
      } | null;
      const gastosV = gastosPorVuelo.get(v.id as string) ?? [];
      // El desglose canónico emite UNA línea TUAS POR AEROPUERTO: el egreso
      // (lo pagado) se adjunta SOLO a la primera — repetirlo en cada línea
      // duplicaba el total de la columna egreso de la hoja.
      let egresoTuasAsignado = false;
      for (const linea of snapshot?.desglose ?? []) {
        const claveLinea = String(linea.clave ?? '');
        if (!/^(TUAS|EXTRA|PERNOCTA)/.test(claveLinea)) continue;
        const montoUsd = num(linea.monto_usd);
        if (montoUsd == null || montoUsd === 0) continue;
        const ingresoMxn = tc != null ? r2(montoUsd * tc) : null;
        let egresoMxn: number | null = null;
        let conceptoEgreso: string | null = null;
        let fechaEgreso: string | null = null;
        if (claveLinea === 'TUAS' && !egresoTuasAsignado) {
          // TUA pagado al aeropuerto: gastos con categoría TUAS + la parte
          // TUA EMBEBIDA en facturas de aeródromo leídas por IA (regla
          // canónica de desglose-gasto.util — caso ASUR "aterrizaje,
          // pernocta, TUA y plataforma": antes solo se detectaba la
          // categoría exacta y ese TUA quedaba fuera del egreso).
          let suma = 0;
          let hubo = false;
          for (const g of gastosV) {
            const monto = num(g.monto) ?? 0;
            let parte = 0;
            if (g.categoria === 'TUAS') {
              parte = monto;
            } else if (
              monto > 0 &&
              // Mismo criterio que el Balance por avión: el TUA embebido
              // solo se separa en facturas de aeródromo/handling — nunca en
              // GAS ni en gastos del piloto.
              !['GAS', 'COMIDA', 'HOTEL', 'TAXI', 'PILOTO_EXTERNO'].includes(
                g.categoria as string,
              )
            ) {
              const partes = desgloseGastoPartes(
                (
                  g as {
                    valor_ia_extraido?: {
                      conceptos?: Array<{ concepto: string; monto: number }>;
                    } | null;
                  }
                ).valor_ia_extraido?.conceptos ?? [],
                r2(monto - (num((g as { propina?: unknown }).propina) ?? 0)) ??
                  monto,
              );
              if (partes && partes.tua > 0) parte = partes.tua;
            }
            if (parte <= 0) continue;
            const tcg = pos(g.tc_gasto);
            const parteMxn =
              g.moneda === 'MXN' ? parte : tcg != null ? parte * tcg : 0;
            if (parteMxn <= 0) continue;
            suma += parteMxn;
            hubo = true;
            fechaEgreso ??= (g.fecha_gasto as string) ?? null;
          }
          if (hubo) {
            egresoMxn = r2(suma);
            conceptoEgreso = 'tuas pagadas';
            egresoTuasAsignado = true;
          }
        }
        otrosIngresos.push({
          clave: claveDe(v),
          fecha_vuelo: (v.fecha_vuelo as string) ?? null,
          concepto_egreso: conceptoEgreso,
          egreso_mxn: egresoMxn,
          fecha_egreso: fechaEgreso,
          concepto_ingreso: String(linea.concepto ?? claveLinea).toLowerCase(),
          ingreso_mxn: ingresoMxn,
          fecha_ingreso: (v.fecha_vuelo as string) ?? null,
          remanente_mxn:
            ingresoMxn != null ? r2(ingresoMxn - (egresoMxn ?? 0)) : null,
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
      ]
        .filter(Boolean)
        .join(' · ');
      if (mxn != null) acumulado += mxn;
      otrosGastos.push({
        fecha: (g.fecha_gasto as string) ?? null,
        concepto,
        monto_mxn: r2(mxn),
        acumulado_mxn: r2(acumulado),
      });
      // Cortes por avión para la hoja utilidades. Con reparto manual, los
      // PARCIALES mandan (aeronave_id del gasto se ignora — regla binaria);
      // cada parcial convierte con la MISMA regla del padre (moneda +
      // tc_gasto): sin TC no se acredita (ya está en el aviso del libro).
      const acreditar = (aid: string, monto_: number) => {
        if (g.categoria === 'INDIRECTO') {
          indirectosPorAvion.set(
            aid,
            (indirectosPorAvion.get(aid) ?? 0) + monto_,
          );
        } else if (g.categoria === 'PERMISO') {
          permisosPorAvion.set(aid, (permisosPorAvion.get(aid) ?? 0) + monto_);
        } else {
          otrosPorAvion.set(aid, (otrosPorAvion.get(aid) ?? 0) + monto_);
        }
      };
      if (filasReparto && filasReparto.length > 0) {
        for (const r of filasReparto) {
          const mxnParcial =
            g.moneda === 'MXN' ? r.monto : tcg != null ? r.monto * tcg : null;
          if (mxnParcial != null) acreditar(r.aeronave_id, mxnParcial);
        }
      } else {
        const aid = g.aeronave_id as string | null;
        if (aid && mxn != null) acreditar(aid, mxn);
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
