import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  PyservicesService,
  type BalanceAvionCobroPayload,
  type BalanceAvionGastoFilaPayload,
  type BalanceAvionHojaGastosPayload,
  type BalanceAvionPayload,
  type BalanceAvionVueloPayload,
} from '../pyservices/pyservices.service';

/** Columnas del vuelo que consume el balance (nombres reales de la tabla). */
const VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, estado, tipo, es_externo, fecha_vuelo, fecha_traslado_final, origen_iata, destino_iata, tiempo_cobrable_hr, tarifa_hora_usd, iva_usd, monto_total_usd, monto_total_mxn, tc_usd_mxn, comision_vendedor_usd, cobrado';

// Mapeo de categorías de gasto por vuelo (contrato del balance):
// GAS aparte (litros/$ x litro); PERMISO e INDIRECTO van a sus hojas propias.
const CAT_OP = new Set(['OPERACIONES', 'ATERRIZAJE', 'TUAS', 'FBO']);
const CAT_PILOTO = new Set(['COMIDA', 'HOTEL', 'TAXI', 'PILOTO_EXTERNO']);

interface VueloRow {
  id: string;
  folio: number | null;
  cliente_id: string | null;
  aeronave_id: string | null;
  estado: string;
  tipo: string | null;
  es_externo: boolean | null;
  fecha_vuelo: string | null;
  fecha_traslado_final: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  tiempo_cobrable_hr: string | number | null;
  tarifa_hora_usd: string | number | null;
  iva_usd: string | number | null;
  monto_total_usd: string | number | null;
  monto_total_mxn: string | number | null;
  tc_usd_mxn: string | number | null;
  comision_vendedor_usd: string | number | null;
  cobrado: boolean | null;
}

interface EscalaRow {
  vuelo_id: string;
  orden: number;
  origen_iata: string | null;
  destino_iata: string | null;
  taco_salida: string | number | null;
  taco_llegada: string | number | null;
  aeronave_id: string | null;
}

interface CobroRow {
  vuelo_id: string;
  monto: string | number | null;
  moneda: string | null;
  tc_usd_mxn: string | number | null;
  metodo_cobro: string | null;
  fecha_cobro: string | null;
}

interface GastoRow {
  vuelo_id: string | null;
  categoria: string;
  monto: string | number | null;
  moneda: string | null;
  tc_gasto: string | number | null;
  litros: string | number | null;
  fecha_gasto: string | null;
  notas: string | null;
  proveedor: { nombre?: string } | { nombre?: string }[] | null;
}

interface SocioRow {
  socio_id: string;
  porcentaje: string | number;
  vigente_desde: string;
  vigente_hasta: string | null;
  usuario: { nombre?: string } | { nombre?: string }[] | null;
}

/** Número finito o null (null se PROPAGA: nunca un 0 falso). */
function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Número positivo o null (para TCs y divisores). */
function pos(v: unknown): number | null {
  const x = num(v);
  return x != null && x > 0 ? x : null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function r2(x: number | null): number | null {
  return x == null ? null : round2(x);
}

/** Día Cancún (YYYY-MM-DD) de un timestamptz. */
function diaCancun(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Cancun',
  }).format(d);
}

/**
 * Balance mensual POR AVIÓN: réplica sistematizada del Excel de control del
 * equipo ("Balance N990GG"). El API calcula TODO el dinero (fórmulas del
 * contrato, verificadas contra el libro original); pyservices solo pinta el
 * XLSX y el panel solo lo descarga.
 *
 * Reglas sagradas que respeta:
 *  - Cortes de periodo en hora Cancún (T00:00:00-05:00 / T23:59:59-05:00).
 *  - Horas de vuelo DERIVADAS de tacómetros (taco_llegada − taco_salida).
 *  - null se propaga (celda vacía): un monto sin TC JAMÁS se suma crudo ni se
 *    vuelve 0 en silencio — se lista en la hoja "pendientes de captura".
 */
@Injectable()
export class AircraftBalanceService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  async xlsx(
    aircraftId: string,
    desde?: string,
    hasta?: string,
  ): Promise<{
    buffer: Buffer;
    matricula: string;
    desde: string;
    hasta: string;
  }> {
    const def = this.mesCorrienteCancun();
    const d = desde ?? def.desde;
    const h = hasta ?? def.hasta;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(h)) {
      throw new BadRequestException('desde/hasta deben ser YYYY-MM-DD');
    }
    if (d > h) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const payload = await this.buildPayload(aircraftId, d, h);
    const buffer = await this.pyservices.generateBalanceAvionXlsx(payload);
    return { buffer, matricula: payload.matricula, desde: d, hasta: h };
  }

  /** Periodo default: mes corriente EN HORA CANCÚN (no UTC). */
  private mesCorrienteCancun(): { desde: string; hasta: string } {
    const hoy = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(new Date()); // YYYY-MM-DD
    const [y, m] = [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7))];
    const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      desde: `${hoy.slice(0, 7)}-01`,
      hasta: `${hoy.slice(0, 7)}-${String(ultimoDia).padStart(2, '0')}`,
    };
  }

  private async buildPayload(
    aircraftId: string,
    desde: string,
    hasta: string,
  ): Promise<BalanceAvionPayload> {
    const sb = this.supabase.service;

    const { data: avion, error: avionErr } = await sb
      .from('aeronave')
      .select('id, matricula, modelo, permiso_afac_usd_hr')
      .eq('id', aircraftId)
      .maybeSingle();
    if (avionErr) throw new Error(avionErr.message);
    if (!avion) throw new NotFoundException(`Aeronave ${aircraftId} not found`);

    // TODOS los estados, CANCELADO incluido: el Excel registra vuelos
    // cancelados con costos ya incurridos (se marcan por estado).
    const vuelosRes = await sb
      .from('vuelo')
      .select(VUELO_COLS)
      .eq('aeronave_id', aircraftId)
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`)
      .order('fecha_vuelo', { ascending: true });
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    const vuelos = (vuelosRes.data ?? []) as VueloRow[];
    const vueloIds = vuelos.map((v) => v.id);

    const vacio = { data: [], error: null } as const;
    const [escalasRes, cobrosRes, gastosVueloRes, gastosAvionRes, sociosRes] =
      await Promise.all([
        vueloIds.length
          ? sb
              .from('escala')
              .select(
                'vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, aeronave_id',
              )
              .in('vuelo_id', vueloIds)
              .order('orden', { ascending: true })
          : Promise.resolve(vacio),
        vueloIds.length
          ? sb
              .from('cobro_vuelo')
              .select(
                'vuelo_id, monto, moneda, tc_usd_mxn, metodo_cobro, fecha_cobro',
              )
              .in('vuelo_id', vueloIds)
              .order('fecha_cobro', { ascending: true })
          : Promise.resolve(vacio),
        vueloIds.length
          ? sb
              .from('gasto')
              .select(
                'vuelo_id, categoria, monto, moneda, tc_gasto, litros, fecha_gasto, notas, proveedor:proveedor_id(nombre)',
              )
              .in('vuelo_id', vueloIds)
              .order('fecha_gasto', { ascending: true })
          : Promise.resolve(vacio),
        // Gastos del avión SIN vuelo en el periodo (fecha_gasto es DATE:
        // comparación de días, sin componente horaria).
        sb
          .from('gasto')
          .select(
            'vuelo_id, categoria, monto, moneda, tc_gasto, litros, fecha_gasto, notas, proveedor:proveedor_id(nombre)',
          )
          .eq('aeronave_id', aircraftId)
          .is('vuelo_id', null)
          .gte('fecha_gasto', desde)
          .lte('fecha_gasto', hasta)
          .order('fecha_gasto', { ascending: true }),
        sb
          .from('aeronave_socio')
          .select(
            'socio_id, porcentaje, vigente_desde, vigente_hasta, usuario:socio_id(nombre)',
          )
          .eq('aeronave_id', aircraftId),
      ]);
    // Un query fallido NO degrada a "sin datos": un balance sin cobros o sin
    // gastos de un mes real es una mentira numérica silenciosa.
    for (const [nombre, res] of [
      ['escalas', escalasRes],
      ['cobros', cobrosRes],
      ['gastos de vuelos', gastosVueloRes],
      ['gastos del avión', gastosAvionRes],
      ['socios', sociosRes],
    ] as const) {
      if (res.error) {
        throw new Error(
          `Balance ${avion.matricula as string}: fallo al leer ${nombre}: ${res.error.message}`,
        );
      }
    }

    const escalas = (escalasRes.data ?? []) as unknown as EscalaRow[];
    const cobros = (cobrosRes.data ?? []) as unknown as CobroRow[];
    const gastosVuelo = (gastosVueloRes.data ?? []) as unknown as GastoRow[];
    const gastosAvion = (gastosAvionRes.data ?? []) as unknown as GastoRow[];
    const sociosAll = (sociosRes.data ?? []) as unknown as SocioRow[];

    // Nombres de clientes (columna CLAVE del Excel).
    const clienteIds = [
      ...new Set(vuelos.map((v) => v.cliente_id).filter(Boolean)),
    ] as string[];
    const clientePorId = new Map<string, string>();
    if (clienteIds.length) {
      const { data: cls, error: clsErr } = await sb
        .from('cliente')
        .select('id, nombre')
        .in('id', clienteIds);
      if (clsErr) throw new Error(clsErr.message);
      for (const c of cls ?? []) {
        clientePorId.set(c.id as string, c.nombre as string);
      }
    }

    const escalasPorVuelo = new Map<string, EscalaRow[]>();
    for (const e of escalas) {
      const list = escalasPorVuelo.get(e.vuelo_id) ?? [];
      list.push(e);
      escalasPorVuelo.set(e.vuelo_id, list);
    }
    const cobrosPorVuelo = new Map<string, CobroRow[]>();
    for (const c of cobros) {
      const list = cobrosPorVuelo.get(c.vuelo_id) ?? [];
      list.push(c);
      cobrosPorVuelo.set(c.vuelo_id, list);
    }
    const gastosPorVuelo = new Map<string, GastoRow[]>();
    for (const g of gastosVuelo) {
      if (!g.vuelo_id) continue;
      const list = gastosPorVuelo.get(g.vuelo_id) ?? [];
      list.push(g);
      gastosPorVuelo.set(g.vuelo_id, list);
    }

    // ===== PASO 1: TC de costos (Z) por vuelo =====
    // Promedio simple de tc_gasto de los gastos MXN del vuelo con TC (el TC
    // del día realmente registrado); fallback el TC de venta (K); sino null.
    const zPorVuelo = new Map<string, number | null>();
    for (const v of vuelos) {
      const tcs = (gastosPorVuelo.get(v.id) ?? [])
        .filter((g) => g.moneda === 'MXN')
        .map((g) => pos(g.tc_gasto))
        .filter((x): x is number => x != null);
      const z = tcs.length
        ? tcs.reduce((a, b) => a + b, 0) / tcs.length
        : pos(v.tc_usd_mxn);
      zPorVuelo.set(v.id, z);
    }
    const zs = [...zPorVuelo.values()].filter((z): z is number => z != null);
    const tcPromedio = zs.length
      ? zs.reduce((a, b) => a + b, 0) / zs.length
      : null;

    const permisoAfacUsdHr = pos(avion.permiso_afac_usd_hr);
    const pendientes: string[] = [];
    const fmtDia = new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Cancun',
      day: '2-digit',
      month: 'short',
    });

    // ===== PASO 2: fila por vuelo =====
    const filasVuelo: BalanceAvionVueloPayload[] = [];
    const anValues: number[] = []; // costo hr USD (AN) para el promedio
    // TUAs/extras/pernocta cobrados al cliente: NO van en las filas (regla
    // del libro) — se acumulan para informarlos al pie (van a la general).
    let otrosIngresosPeriodoUsd = 0;
    for (const v of vuelos) {
      const vEscalas = escalasPorVuelo.get(v.id) ?? [];
      const vCobros = cobrosPorVuelo.get(v.id) ?? [];
      const vGastos = gastosPorVuelo.get(v.id) ?? [];
      const z = zPorVuelo.get(v.id) ?? null;
      const esExterno = v.es_externo === true;

      // Ruta operativa: concatenación de escalas; fallback origen→destino.
      const codigos = vEscalas.length
        ? [
            vEscalas[0].origen_iata ?? '?',
            ...vEscalas.map((e) => e.destino_iata ?? '?'),
          ]
        : [v.origen_iata ?? '?', v.destino_iata ?? '?'];
      const ruta = codigos.join('-');
      const folio = v.folio != null ? String(v.folio) : v.id.slice(0, 8);
      const etiqueta = `Vuelo #${folio} (${
        v.fecha_vuelo
          ? fmtDia.format(new Date(v.fecha_vuelo)).replace(/\s+/g, '-')
          : 'sin fecha'
      } ${ruta})`;

      // ----- Bloque VENTA -----
      // REGLA DEL LIBRO (corrección 20-jul, indicación del cliente): la fila
      // individual lleva SOLO lo del vuelo — horas cobradas × tarifa, con o
      // sin IVA (fórmulas exactas del Excel original: I=D×H, J=D×G, L=I×K).
      // TUAs/extras/pernocta/transportes son OTROS INGRESOS y van al control
      // GENERAL, no a la fila: aquí solo se informa el acumulado del periodo
      // al pie para trasladarlo a la general.
      const D = num(v.tiempo_cobrable_hr) ?? 0; // horas cobradas (0 sin cotización)
      const E = num(v.tarifa_hora_usd);
      const totalSistemaUsd = num(v.monto_total_usd); // total cotizado (con TUAS/extras)
      const ivaSistemaUsd = num(v.iva_usd);
      // Con/sin IVA por vuelo (columna G del libro): si la cotización lleva
      // IVA, G = E×0.16; si no (sin factura), 0.
      const conIva = (ivaSistemaUsd ?? 0) > 0;
      const G = E != null ? (conIva ? round2(E * 0.16) : 0) : null;
      const H = E != null ? round2(E + (G ?? 0)) : null;
      const I = H != null && D > 0 ? round2(D * H) : null; // venta del vuelo
      const J = G != null && D > 0 ? round2(D * G) : null; // IVA del vuelo
      const K = pos(v.tc_usd_mxn);
      const L = I != null && K != null ? round2(I * K) : null;
      const M = J != null && K != null ? round2(J * K) : null;
      const N = L != null ? round2(L - (M ?? 0)) : null;
      // Otros ingresos del vuelo (TUAS/extras/pernocta/ajustes): diferencia
      // entre el total cotizado del sistema y la venta por horas. Se acumula
      // para informarlo al pie (va a la general, no a la fila).
      const otrosIngresosUsd =
        totalSistemaUsd != null && (I != null || D === 0)
          ? round2(totalSistemaUsd - (I ?? 0))
          : null;
      if (otrosIngresosUsd != null) otrosIngresosPeriodoUsd += otrosIngresosUsd;

      // ----- Bloque TIEMPO/TACO (derivado de tacómetros, fuente única) -----
      // Solo tramos volados en ESTE avión: con asignación por tramo, un tramo
      // en otro avión tiene tacómetro propio y mezclaría lecturas.
      const escalasDelAvion = vEscalas.filter(
        (e) => e.aeronave_id == null || e.aeronave_id === aircraftId,
      );
      let horas: number | null = null;
      for (const e of escalasDelAvion) {
        const s = num(e.taco_salida);
        const l = num(e.taco_llegada);
        if (s == null || l == null) continue;
        const h = l - s;
        if (h <= 0) continue;
        horas = (horas ?? 0) + h;
      }
      const O = r2(horas);
      const salidas = escalasDelAvion
        .map((e) => num(e.taco_salida))
        .filter((x): x is number => x != null);
      const llegadas = escalasDelAvion
        .map((e) => num(e.taco_llegada))
        .filter((x): x is number => x != null);
      const P = salidas.length ? salidas[0] : null;
      const Q = llegadas.length ? llegadas[llegadas.length - 1] : null;

      // ----- Bloque COSTOS (MXN) -----
      // Conversión de un gasto USD a MXN: tc_gasto ?? Z del vuelo ?? TC
      // promedio del periodo. Sin ningún TC → null (pendiente), JAMÁS crudo.
      const gastoMxn = (g: GastoRow): number | null => {
        const monto = num(g.monto) ?? 0;
        if (g.moneda === 'MXN') return monto;
        const tc = pos(g.tc_gasto) ?? z ?? tcPromedio;
        return tc != null ? monto * tc : null;
      };
      let gasMxn: number | null = null;
      let gasLitros: number | null = null;
      let opMxn: number | null = null;
      let pilotoMxn: number | null = null;
      let otrosMxn: number | null = null;
      let usdSinTc = 0;
      let usdSinTcMonto = 0;
      let gasSinLitros = 0;
      let tuvoGas = false;
      for (const g of vGastos) {
        // PERMISO va a su hoja (con o sin vuelo) y se excluye del costo del
        // vuelo para no contar doble; INDIRECTO no es costo directo.
        if (g.categoria === 'PERMISO' || g.categoria === 'INDIRECTO') continue;
        const mxn = gastoMxn(g);
        if (mxn == null) {
          usdSinTc += 1;
          usdSinTcMonto += num(g.monto) ?? 0;
          continue;
        }
        if (g.categoria === 'GAS') {
          tuvoGas = true;
          gasMxn = (gasMxn ?? 0) + mxn;
          const litros = pos(g.litros);
          if (litros != null) gasLitros = (gasLitros ?? 0) + litros;
          else gasSinLitros += 1;
        } else if (CAT_OP.has(g.categoria)) {
          opMxn = (opMxn ?? 0) + mxn;
        } else if (CAT_PILOTO.has(g.categoria)) {
          pilotoMxn = (pilotoMxn ?? 0) + mxn;
        } else {
          // OTRO, REFACCION, FIJO y cualquier categoría futura no mapeada.
          otrosMxn = (otrosMxn ?? 0) + mxn;
        }
      }
      const T =
        gasMxn != null && gasLitros != null && gasLitros > 0
          ? round2(gasMxn / gasLitros)
          : null;
      // Provisión AFAC (X) = tarifa USD/hr × TC de costos × horas COBRADAS —
      // solo si el avión tiene la config Y hay TC Y hay horas cobradas.
      const X =
        permisoAfacUsdHr != null && z != null && D > 0
          ? round2(permisoAfacUsdHr * z * D)
          : null;
      const Y = round2(
        (gasMxn ?? 0) +
          (opMxn ?? 0) +
          (pilotoMxn ?? 0) +
          (otrosMxn ?? 0) +
          (X ?? 0),
      );

      // ----- Bloque INDICADORES USD e IVA -----
      const AE = z != null ? Y / z : null;
      const AF = AE != null ? AE / 1.16 : null;
      const AG = AE != null && AF != null ? AE - AF : null;
      const AH = AG != null && z != null ? AG * z : null;
      const AI = round2((L ?? 0) - Y);
      const AJ = round2((M ?? 0) - (AH ?? 0));
      // Comisión del vendedor: vuelo.comision_vendedor_usd (sale del precio,
      // interna). A MXN con el TC de venta (K); sin K queda pendiente.
      const comUsd = pos(v.comision_vendedor_usd);
      const AK = comUsd != null && K != null ? round2(comUsd * K) : null;
      if (comUsd != null && K == null) {
        pendientes.push(
          `${etiqueta}: comisión de vendedor en USD sin TC de venta — no entra al balance MXN`,
        );
      }
      const AL = round2(AI - (AK ?? 0));
      const AM = z != null ? round2(AL / z) : null;
      const AN = AE != null && O != null && O > 0 ? AE / O : null;
      const AO = AN != null ? AN / 1.16 : null;
      if (AN != null) anValues.push(AN);

      // ----- Bloque STATUS DE COBROS -----
      let cobroSinTc = 0;
      const cobrosOut: BalanceAvionCobroPayload[] = vCobros.map((c) => {
        const monto = num(c.monto) ?? 0;
        let mxn: number | null;
        if (c.moneda === 'MXN') {
          mxn = round2(monto);
        } else {
          const tc = pos(c.tc_usd_mxn) ?? K;
          mxn = tc != null ? round2(monto * tc) : null;
        }
        if (mxn == null) cobroSinTc += 1;
        return {
          fecha: diaCancun(c.fecha_cobro),
          monto_mxn: mxn,
          metodo: c.metodo_cobro ?? null,
        };
      });
      const cobradoMxn = round2(
        cobrosOut.reduce((acc, c) => acc + (c.monto_mxn ?? 0), 0),
      );
      const porCobrarMxn = round2((L ?? 0) - cobradoMxn);
      const porCobrarUsd = K != null ? round2(porCobrarMxn / K) : null;
      const statusCobro =
        v.cobrado === true
          ? 'Cobrado'
          : vCobros.length > 0
            ? 'Parcial'
            : (L ?? 0) > 0
              ? 'Pendiente'
              : '—';

      // ----- Pendientes de captura por vuelo (lista generosa) -----
      const cancelado = v.estado === 'CANCELADO';
      const yaVolo = v.estado === 'EN_VUELO' || v.estado === 'COMPLETADO';
      if ((totalSistemaUsd ?? 0) === 0 && D === 0 && !cancelado) {
        pendientes.push(
          `${etiqueta}: sin cotización — montos de venta en $0 (¿traslado/servicio o falta cotizar?)`,
        );
      }
      if ((L ?? 0) > 0 && vCobros.length === 0) {
        pendientes.push(`${etiqueta}: sin cobros registrados`);
      }
      if (!tuvoGas && usdSinTc === 0 && yaVolo && !esExterno) {
        pendientes.push(`${etiqueta}: sin gastos de combustible (GAS)`);
      }
      if (gasSinLitros > 0) {
        pendientes.push(
          `${etiqueta}: ${gasSinLitros} gasto(s) GAS sin litros — precio por litro incompleto`,
        );
      }
      if (O == null && !esExterno && !cancelado) {
        pendientes.push(
          yaVolo
            ? `${etiqueta}: sin tacómetros — horas voladas vacías`
            : `${etiqueta}: sin tacómetros (vuelo aún no volado — ok si es futuro)`,
        );
      }
      if (usdSinTc > 0) {
        pendientes.push(
          `${etiqueta}: ${usdSinTc} gasto(s) en USD por $${usdSinTcMonto.toLocaleString(
            'en-US',
          )} sin ningún TC — fuera del costo MXN (captura su TC en Gastos)`,
        );
      }
      if (cobroSinTc > 0) {
        pendientes.push(
          `${etiqueta}: ${cobroSinTc} cobro(s) en USD sin TC (ni TC del vuelo) — parcialidad vacía en MXN`,
        );
      }
      // Regla del cliente: NUNCA se cobran menos horas de las voladas. Si el
      // tacómetro registró más de lo cotizado, hay que recotizar el vuelo
      // (revisar cotización con las horas reales). Solo aplica con cotización
      // (D>0; sin cotización ya sale su propio pendiente).
      if (D > 0 && O != null && O - D > 0.01) {
        pendientes.push(
          `${etiqueta}: voló ${O.toFixed(2)} hr y solo se cobraron ${D.toFixed(
            2,
          )} — recotizar con las horas reales (lo cobrado no puede ser menor a lo volado)`,
        );
      }

      const cliente = v.cliente_id
        ? (clientePorId.get(v.cliente_id) ?? null)
        : null;
      filasVuelo.push({
        // CLAVE del libro: folio del sistema + nombre del cliente (el libro
        // original usaba claves tipo "vt<apellido>"; el nombre real es más
        // claro para el equipo y el folio amarra la fila al sistema).
        clave: `#${folio}${cliente ? ` · ${cliente}` : ''}`,
        folio,
        cliente,
        estado: v.estado,
        es_externo: esExterno,
        fecha: diaCancun(v.fecha_vuelo),
        fecha_fin:
          diaCancun(v.fecha_traslado_final) !== diaCancun(v.fecha_vuelo)
            ? diaCancun(v.fecha_traslado_final)
            : null,
        ruta,
        horas_cobradas: round2(D),
        tarifa_usd: r2(E),
        iva_hr_usd: G,
        total_usd: I, // venta del vuelo = horas × tarifa c/IVA (regla del libro)
        iva_usd: J,
        tc_venta: K,
        total_mxn: L,
        iva_mxn: M,
        subtotal_mxn: N,
        tiempo_vuelo: O,
        taco_inicio: P,
        taco_fin: Q,
        gas_mxn: r2(gasMxn),
        gas_litros: gasLitros,
        gas_precio_litro: T,
        op_mxn: r2(opMxn),
        piloto_mxn: r2(pilotoMxn),
        otros_mxn: r2(otrosMxn),
        permiso_afac_mxn: X,
        costo_total_mxn: Y,
        tc_costos: z,
        costo_usd: r2(AE),
        costo_usd_siva: r2(AF),
        iva_pagado_usd: r2(AG),
        iva_pagado_mxn: r2(AH),
        remanente_mxn: AI,
        dif_iva_mxn: AJ,
        comision_vendedor_mxn: AK,
        ganancia_mxn: AL,
        ganancia_usd: AM,
        costo_hr_usd: r2(AN),
        costo_hr_usd_siva: r2(AO),
        status_cobro: statusCobro,
        cobros: cobrosOut,
        cobrado_mxn: cobradoMxn,
        por_cobrar_mxn: porCobrarMxn,
        por_cobrar_usd: porCobrarUsd,
      });
    }

    // ===== Totales del periodo (suma de no nulos; promedios SOLO no nulos) =====
    const sum = (f: (r: BalanceAvionVueloPayload) => number | null): number =>
      round2(filasVuelo.reduce((acc, r) => acc + (f(r) ?? 0), 0));
    const horasVoladas = sum((r) => r.tiempo_vuelo);
    const totales = {
      horas_cobradas: sum((r) => r.horas_cobradas),
      tiempo_vuelo: horasVoladas,
      total_mxn: sum((r) => r.total_mxn),
      iva_mxn: sum((r) => r.iva_mxn),
      subtotal_mxn: sum((r) => r.subtotal_mxn),
      gas_mxn: sum((r) => r.gas_mxn),
      gas_litros: sum((r) => r.gas_litros),
      op_mxn: sum((r) => r.op_mxn),
      piloto_mxn: sum((r) => r.piloto_mxn),
      otros_mxn: sum((r) => r.otros_mxn),
      permiso_afac_mxn: sum((r) => r.permiso_afac_mxn),
      costo_total_mxn: sum((r) => r.costo_total_mxn),
      remanente_mxn: sum((r) => r.remanente_mxn),
      dif_iva_mxn: sum((r) => r.dif_iva_mxn),
      comision_vendedor_mxn: sum((r) => r.comision_vendedor_mxn),
      ganancia_mxn: sum((r) => r.ganancia_mxn),
      ganancia_usd: sum((r) => r.ganancia_usd),
      cobrado_mxn: sum((r) => r.cobrado_mxn),
      por_cobrar_mxn: sum((r) => r.por_cobrar_mxn),
      por_cobrar_usd: sum((r) => r.por_cobrar_usd),
      tc_promedio: tcPromedio != null ? round2(tcPromedio) : null,
      costo_hr_prom_usd: anValues.length
        ? round2(anValues.reduce((a, b) => a + b, 0) / anValues.length)
        : null,
      // Informativo al pie: NO suma en las columnas (va al control general).
      otros_ingresos_usd: round2(otrosIngresosPeriodoUsd),
    };

    // ===== Hojas de gastos (indirectos / otros / permisos) =====
    // INDIRECTO ligado a vuelo no debería existir, pero si existe NO se pierde:
    // cae a su hoja igual que los sin vuelo.
    const filasIndirectos = [
      ...gastosAvion.filter((g) => g.categoria === 'INDIRECTO'),
      ...gastosVuelo.filter((g) => g.categoria === 'INDIRECTO'),
    ];
    const filasOtros = gastosAvion.filter(
      (g) => g.categoria !== 'INDIRECTO' && g.categoria !== 'PERMISO',
    );
    // Permisos: pagos reales de PERMISO del avión, CON o SIN vuelo.
    const filasPermisos = [
      ...gastosAvion.filter((g) => g.categoria === 'PERMISO'),
      ...gastosVuelo.filter((g) => g.categoria === 'PERMISO'),
    ];
    const hojaIndirectos = this.buildHoja(
      filasIndirectos,
      tcPromedio,
      horasVoladas,
      'gastos indirectos',
      pendientes,
    );
    const hojaOtros = this.buildHoja(
      filasOtros,
      tcPromedio,
      horasVoladas,
      'otros gastos',
      pendientes,
    );
    const hojaPermisos = this.buildHoja(
      filasPermisos,
      tcPromedio,
      horasVoladas,
      'permisos',
      pendientes,
    );

    // ===== Balance (todo USD; null se propaga si falta TC) =====
    const utilidadAntes = totales.ganancia_usd;
    const hojasUsd = [hojaIndirectos.usd, hojaOtros.usd, hojaPermisos.usd];
    const utilidadDespues = hojasUsd.every((u) => u != null)
      ? round2(
          utilidadAntes -
            (hojaIndirectos.usd ?? 0) -
            (hojaOtros.usd ?? 0) -
            (hojaPermisos.usd ?? 0),
        )
      : null;
    const porCobrarUsdTotal = totales.por_cobrar_usd;
    const utilidadCobrada =
      utilidadDespues != null
        ? round2(utilidadDespues - porCobrarUsdTotal)
        : null;

    // Socios vigentes en el periodo (mismo criterio de vigencia que el módulo
    // de reparto) con nombre real desde usuario.
    const socios = sociosAll
      .filter(
        (s) =>
          s.vigente_desde <= hasta &&
          (s.vigente_hasta === null || s.vigente_hasta >= desde),
      )
      .sort((a, b) => Number(b.porcentaje) - Number(a.porcentaje))
      .map((s) => {
        const u = Array.isArray(s.usuario) ? s.usuario[0] : s.usuario;
        const pct = Number(s.porcentaje);
        return {
          nombre: u?.nombre ?? 'Socio',
          porcentaje: pct,
          monto_usd:
            utilidadCobrada != null
              ? round2((pct / 100) * utilidadCobrada)
              : null,
        };
      });

    // ===== Pendientes a nivel avión =====
    if (hojaIndirectos.filas.length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin gastos INDIRECTOS en el periodo — verificar que no falte captura`,
      );
    }
    if (permisoAfacUsdHr == null) {
      pendientes.push(
        `Avión ${avion.matricula as string}: provisión permiso AFAC no configurada (campo "Aportación AFAC USD/hr" en la ficha del avión) — columna PERMISO AFAC vacía`,
      );
    }
    if (tcPromedio == null && vuelos.length > 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin TC de costos en ningún vuelo del periodo — indicadores USD vacíos`,
      );
    }
    if (socios.length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin socios vigentes configurados — el balance no reparte la utilidad`,
      );
    } else {
      pendientes.push(
        `Socios: porcentajes registrados ${socios
          .map((s) => `${s.nombre} ${s.porcentaje}%`)
          .join(' / ')} — verificar contra el reparto real del avión`,
      );
    }
    if (utilidadDespues == null) {
      pendientes.push(
        `Avión ${avion.matricula as string}: hojas de gastos sin TC promedio — la utilidad después de gastos queda vacía`,
      );
    }
    if (vuelos.length === 0) {
      pendientes.push(
        `Avión ${avion.matricula as string}: sin vuelos en el periodo ${desde} a ${hasta}`,
      );
    }

    return {
      generado: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Cancun',
      }).format(new Date()),
      matricula: avion.matricula as string,
      modelo: (avion.modelo as string | null) ?? null,
      periodo_desde: desde,
      periodo_hasta: hasta,
      permiso_afac_usd_hr: permisoAfacUsdHr,
      tc_promedio: totales.tc_promedio,
      horas_voladas_hr: horasVoladas,
      vuelos: filasVuelo,
      totales,
      gastos_indirectos: hojaIndirectos,
      otros_gastos: hojaOtros,
      permisos: hojaPermisos,
      balance: {
        utilidad_antes_usd: utilidadAntes,
        gastos_indirectos_usd: hojaIndirectos.usd,
        otros_usd: hojaOtros.usd,
        permisos_usd: hojaPermisos.usd,
        utilidad_despues_usd: utilidadDespues,
        por_cobrar_usd: porCobrarUsdTotal,
        utilidad_cobrada_usd: utilidadCobrada,
        socios,
      },
      pendientes,
    };
  }

  /**
   * Hoja tipo ledger (gastos indirectos / otros / permisos): filas + resumen
   * al TC promedio del periodo. Un gasto USD sin TC (ni tc_gasto ni promedio)
   * queda con monto_mxn null Y se reporta en pendientes — nunca desaparece.
   */
  private buildHoja(
    gastos: GastoRow[],
    tcPromedio: number | null,
    horasVoladas: number,
    nombreHoja: string,
    pendientes: string[],
  ): BalanceAvionHojaGastosPayload {
    const filas: BalanceAvionGastoFilaPayload[] = [...gastos]
      .sort((a, b) => (a.fecha_gasto ?? '').localeCompare(b.fecha_gasto ?? ''))
      .map((g) => {
        const monto = num(g.monto) ?? 0;
        const proveedor = Array.isArray(g.proveedor)
          ? g.proveedor[0]?.nombre
          : g.proveedor?.nombre;
        const detalle =
          g.notas?.trim() ||
          [g.categoria, proveedor].filter(Boolean).join(' · ');
        let mxn: number | null;
        if (g.moneda === 'MXN') {
          mxn = round2(monto);
        } else {
          const tc = pos(g.tc_gasto) ?? tcPromedio;
          mxn = tc != null ? round2(monto * tc) : null;
          if (mxn == null) {
            pendientes.push(
              `Hoja "${nombreHoja}" (${g.fecha_gasto ?? 'sin fecha'}): gasto en ${
                g.moneda ?? 'USD'
              } por $${monto.toLocaleString('en-US')} sin ningún TC — fila sin monto MXN`,
            );
          }
        }
        return {
          fecha: g.fecha_gasto ?? null,
          detalle,
          monto_mxn: mxn,
          moneda_original: g.moneda !== 'MXN' ? (g.moneda ?? null) : null,
          monto_original: g.moneda !== 'MXN' ? round2(monto) : null,
        };
      });
    const totalMxn = round2(
      filas.reduce((acc, f) => acc + (f.monto_mxn ?? 0), 0),
    );
    // Sin partidas no hay nada que convertir: usd = 0 real, no null.
    const usd =
      totalMxn === 0
        ? 0
        : tcPromedio != null
          ? round2(totalMxn / tcPromedio)
          : null;
    const usdHr =
      usd != null && horasVoladas > 0 ? round2(usd / horasVoladas) : null;
    return { filas, total_mxn: totalMxn, usd, usd_hr: usdHr };
  }
}
