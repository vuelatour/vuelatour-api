import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  exigirPeriodoDesdeInicio,
  inicioOficialDe,
} from '../../common/inicio-oficial.util';
import {
  CATEGORIAS_GASTO_EMPRESA,
  categoriaEsDeEmpresa,
  categoriaFueraDelAvion,
  etiquetaCategoriaGasto,
} from '../../common/categoria-gasto.util';
import {
  NOTA_PAGO_VENDEDOR_REAL,
  NOTA_PAGO_VENDEDOR_SIN_LINEA,
  conceptoPagoVendedorReal,
  motivoSinLineaComision,
  pagosVendedorDeVuelo,
  type GastoPagoVendedorRow,
} from '../../common/pago-vendedor.util';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  notaParteAvionDinero,
  pagoVendedorAvionEnUniverso,
  sufijoParteAvionDinero,
} from '../../common/comisiones-avion.util';
import { round6, totalMxnDeVuelo } from '../../common/tc.util';
import {
  CONCEPTO_EXTENSION_PAGADA,
  esExtension,
  trasladosPagadosDeGasto,
} from '../../common/desglose-gasto.util';
// «TUA incluida» de la oficina (13-oct-2026, invariante 66): sonda ÚNICA.
import {
  colTuaIncluida,
  tuaIncluidaDisponible,
} from '../../common/tua-incluida-disponible.util';
import { fetchRepartos } from '../../common/gasto-reparto.util';
// AFAC POR VUELO (16-oct-2026, invariante 90): un PERMISO marcado «Pago de
// AFAC» sigue en «otros gastos» del mes (es caja real) pero NO se acredita a
// ningún avión en utilidades (lo paga VuelaTour). Detrás de la sonda.
import {
  afacRealDisponible,
  colPagoAfac,
} from '../../common/afac-real-disponible.util';
import {
  SUFIJO_DINERO_PAGO_AFAC,
  esPagoAfac,
} from '../../common/afac-real.util';
import { esVueloDeServicio } from '../../common/vuelo-servicio.util';
// CONSECUTIVO del vuelo por cliente (23-oct-2026, invariante 106): columna
// propia del libro (lector único best-effort); el ID ya no se imprime.
import { consecutivosClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
import { cierreMesDisponible } from '../../common/cierre-mes-disponible.util';
import {
  colPeriodoContable,
  colsVueloContable,
} from '../../common/filtro-periodo-contable.util';
import {
  corteDeDestino,
  decisionDiferir,
  leyendaPasaA,
  leyendaPasara,
  leyendaVieneDe,
  marcaPasaraAlCerrar,
  mesCalendarioDeRango,
  mesContableDeVuelo,
  mesRealDeVuelo,
  mesSiguienteDe,
  origenDeVuelo,
  papelContableEnPeriodo,
  rangoDelMes,
  salidaDeVuelo,
  type EstadoMesFlota,
  type MotivoDiferir,
} from '../../common/mes-contable.util';
import {
  leerCierresMes,
  leerDiferimientos,
  resumenCierreFlota,
} from '../../common/cierre-mes.lector';
import type {
  BalanceCierrePayload,
  BalanceCierreVueloPayload,
} from '../aircraft/cierre-balance.util';

/** Columnas de `vuelo` del Libro Dinero (las de siempre; 0.0.87). */
const DINERO_VUELO_COLS =
  'id, folio, cliente_id, aeronave_id, estado, es_externo, fecha_vuelo, tiempo_cobrable_hr, tarifa_hora_usd, iva_usd, iva_pct, monto_total_usd, monto_total_mxn, tc_usd_mxn, cobrado, calculo_snapshot, subtotal_vuelo_usd, ajuste_final_usd, comision_vendedor_usd, comision_vendedor_nombre, tuas_usd, extras_total_usd, viaticos_pernocta_usd';
import {
  CLIENTE_VUELO_SERVICIO,
  claveDinero,
} from '../../common/clave-cliente.util';
import {
  ivaComisionVendedorUsd,
  pagoVendedorUsd,
  particionIngresoVuelo,
} from '../../common/ingreso-vuelo.util';
import {
  avionDelGasto,
  avionQueReporta,
  factorDe,
  parteFilaDeCobro,
  participacionPorAeronave,
  repartirUsd,
  type ParticipacionAeronave,
} from '../../common/participacion-aeronave.util';
import { etiquetasFacturaDeVuelos } from '../flights/factura-cliente-etiquetas';
import {
  filaLibroDeIngreso,
  ingresoEsDelAvion,
  leerIngresosDeResultado,
  partirIngresosPorAvion,
} from '../../common/ingreso-resultado.util';
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
/** "50 %", "33.33 %". */
function pctLabel(f: number): string {
  return `${Math.round(f * 10000) / 100} %`;
}
/**
 * Reparte HORAS (no dinero) entre los aviones con los factores de la
 * participación: 4 decimales y el residuo en el avión principal (o el
 * primero), Σ partes == horas exacto. `repartirUsd` trunca a centavos y
 * 1.2033 h saldría 1.2 en cada fila.
 */
function repartirHoras(
  horas: number,
  p: ParticipacionAeronave,
): Map<string, number> {
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const out = new Map<string, number>();
  const ids = [...p.factores.keys()];
  if (ids.length === 0) return out;
  const receptor =
    p.principal && p.factores.has(p.principal) ? p.principal : ids[0];
  let otros = 0;
  for (const id of ids) {
    if (id === receptor) continue;
    const parte = r4(horas * (p.factores.get(id) ?? 0));
    out.set(id, parte);
    otros += parte;
  }
  out.set(receptor, r4(horas - otros));
  return out;
}

/**
 * Libro "Dinero <periodo>": réplica del control manual del equipo (Excel
 * "Dinero Junio COMPLETO"). El sistema llena lo que SABE con sus fuentes
 * únicas — venta del avión (particionIngresoVuelo), cobros, facturas, otros
 * ingresos (TUAs/extras/pernocta/comisión del vendedor del desglose
 * canónico), otros gastos del mes, indirectos y combustible — y deja VACÍAS,
 * conservando su columna, las secciones sin regla definida todavía: costo
 * por hora del proveedor y pagos a proveedor (el equipo pasará esas reglas;
 * no se inventan números).
 *
 * COMISIÓN DEL VENDEDOR (Regla A del cliente, 28-ago-2026 tarde): NO es
 * costo del avión — es INGRESO de VuelaTour (como un extra) que VuelaTour
 * paga al vendedor. La hoja 1 (venta del avión) no la cobra ni la descuenta
 * (ninguna columna "comisión" de esa hoja se llena con ella); la hoja
 * "otros ingresos" la lista como ingreso (comisión + su IVA) apareada con su
 * pago como egreso: el GASTO REAL ligado al vuelo (desde el 28-sep-2026 —
 * invariante 31, fuente única `pago-vendedor.util.ts`, la MISMA del Balance
 * general), en sus DOS categorías desde el 13-oct-2026 (API 0.0.74,
 * invariante 61): «Comisión del vendedor (VuelaTour)» y «Comisión del
 * vendedor (avión)». NO hay provisión: mientras no se capture el pago la
 * fila no lleva egreso y nada se resta. ESTE LIBRO ES LA CAJA DE VUELATOUR
 * (no tiene utilidad ni columna COMISIONES por avión): resta UNA vez los
 * pagos de LAS DOS categorías en todo vuelo, porque el dinero salió de
 * VuelaTour — aunque en el Balance general y en el reparto la «(avión)» la
 * cargue el avión en su columna COMISIONES. La «(VuelaTour)» resta igual en
 * los dos libros; la DIFERENCIA ESPERADA con el bloque VUELATOUR del Balance
 * general es EXACTAMENTE la Σ de los pagos «(avión)» que carga un avión (lo
 * dicen el concepto, la nota de la celda y la llave informativa
 * `utilidades_comision_vendedor_avion_mxn`). Si CHARTERS/UTILIDAD llegan a
 * tener regla por avión, la «(avión)» que carga un avión debe dejar de
 * restarse aquí (si no, se contaría dos veces).
 *
 * MULTI-AVIÓN (Regla B, 28-ago-2026): un vuelo cuyos tramos volaron aviones
 * distintos emite en la hoja 1 UNA FILA POR AVIÓN, coherente por sí sola:
 * su parte de la venta del avión, IVA y horas cobradas (fuente única
 * participacionPorAeronave + repartirUsd — partes iguales por tramo
 * vendido; Σ filas == vuelo al centavo) y su total del cliente, cobros y
 * "me deben" con la MISMA partición: la fila del avión que reporta
 * (`avionQueReporta`, misma regla que balance y reparto) lleva su parte del
 * avión + la parte VuelaTour; las demás solo su parte del avión — nunca el
 * total completo junto a cobros repartidos. La hoja "otros ingresos" sale
 * UNA sola vez por vuelo. Los gastos no se reparten: van al avión del tramo
 * ligado (avionDelGasto).
 *
 * **LA CATEGORÍA DE EMPRESA MANDA SOBRE EL VUELO (cliente, 11-sep-2026)**:
 * OTRO, NOMINA, GASOLINA, FIJO y VISITA (fuente única
 * `CATEGORIAS_GASTO_EMPRESA`) son gasto de VuelaTour aunque el gasto traiga
 * vuelo o avión sellado: entran ENTEROS en la hoja "otros gastos" (con el
 * folio como referencia en el concepto), NO se acreditan a ningún avión en
 * la hoja utilidades y su parte TUA embebida NO sale además como egreso en
 * "otros ingresos" (sería restar dos veces en el mismo libro). Única
 * excepción: los PARCIALES de un reparto MANUAL, que sí van al avión de
 * cada parte. Misma regla, mismo helper y mismos números que el Balance por
 * avión y el reparto a socios — los tres libros del cierre cuadran.
 */
@Injectable()
export class DineroReportService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
    // INICIO OFICIAL (16-oct-2026, invariante 86). @Optional y ÚLTIMO (los
    // specs construyen por posición; sin él ⇒ como 0.0.83).
    @Optional()
    private readonly configuracion?: ConfiguracionService,
  ) {}

  async xlsx(
    desdePedido: string,
    hasta: string,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(desdePedido) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(hasta)
    ) {
      throw new BadRequestException('desde/hasta deben ser YYYY-MM-DD');
    }
    if (desdePedido > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    // Forma R: el periodo subido va en el libro y en el nombre del archivo.
    const { desde } = exigirPeriodoDesdeInicio(
      desdePedido,
      hasta,
      await inicioOficialDe(this.configuracion),
    );
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
    // CIERRE DE MES (16-oct-2026, invariante 89): el Libro Dinero es de
    // DINERO — con la migración los vuelos se leen por `fecha_contable` (un
    // vuelo diferido aparece completo en el mes destino y NO en el de
    // origen; ahí lo dice la lista `cierre.pasan`). Sin ella, `fecha_vuelo`.
    const contable = await cierreMesDisponible(sb);
    const colDinero = colPeriodoContable(contable);

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
        // comision_vendedor_nombre: etiqueta de la línea de comisión en la
        // hoja "otros ingresos" (Regla A).
        `${DINERO_VUELO_COLS}${colsVueloContable(contable)}`,
      )
      .in('estado', ['CONFIRMADO', 'EN_VUELO', 'COMPLETADO', 'CANCELADO'])
      .gte(colDinero, d1)
      .lte(colDinero, d2)
      .order('fecha_vuelo', { ascending: true });
    if (vuelosRes.error) throw new Error(vuelosRes.error.message);
    const vuelosPeriodo = (vuelosRes.data ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    const vueloIds = vuelosPeriodo.map((v) => v.id as string);

    // TUA de oficina (13-oct-2026, invariante 66): UNA lectura de la sonda
    // antes del lote; solo la consulta de gastos de los vuelos la usa.
    const colTua = colTuaIncluida(await tuaIncluidaDisponible(sb));
    const colAfac = colPagoAfac(await afacRealDisponible(sb));
    const [
      aeronavesRes,
      clientesRes,
      escalasRes,
      cobrosRes,
      gastosVuelo,
      facturasRes,
      gastosEmpresaYSueltos,
      gastosGasRes,
      ingresosResultado,
      consecutivosCliente,
    ] = await Promise.all([
      sb
        .from('aeronave')
        .select('id, matricula, modelo, color_calendario')
        .order('matricula'),
      sb.from('cliente').select('id, nombre'),
      // Escalas con los campos de participacionPorAeronave/avionDelGasto
      // (Regla B). Se traen TAMBIÉN las canceladas: no participan en ruta,
      // clave ni reparto (se filtran abajo / en la fuente única), pero un
      // gasto ligado a un tramo cancelado sigue siendo del avión del tramo.
      vueloIds.length
        ? sb
            .from('escala')
            .select(
              // solo_operativa / es_ferry: los tramos operativos no reparten
              // la venta (fuente única participacionPorAeronave).
              'id, vuelo_id, orden, aeronave_id, cancelada_at, taco_salida, taco_llegada, solo_operativa, es_ferry, origen_iata, destino_iata, es_sobrevuelo, tipo_parada, pasajeros',
            )
            .in('vuelo_id', vueloIds)
            // Orden determinista (vuelo, orden): mismos desempates de
            // participación que balance y reparto (verificación 28-ago).
            .order('vuelo_id', { ascending: true })
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
              `vuelo_id, categoria, monto, propina, moneda, tc_gasto, fecha_gasto, notas, valor_ia_extraido${colTua}`,
            )
            .in('vuelo_id', vueloIds)
        : Promise.resolve({ data: [], error: null } as const),
      // FACTURA del vuelo (24-sep-2026): fuente única compartida con el
      // Balance — CFDI vivo → emitidas VIGENTES → folio de la factura del
      // servicio → estatus manual («Facturado» / «Factura elaborada y
      // enviada») → desde el 13-oct-2026 (invariante 60) «Pendiente de
      // factura» / «No lleva factura» según los cobros; null = sin cobros.
      // En lote (4 consultas por cada 200 vuelos, la de cobros paginada).
      etiquetasFacturaDeVuelos(sb, vueloIds),
      // "Otros gastos" del mes: los sueltos SIN vuelo de siempre (pensión,
      // cera, nómina, etc.) MÁS, desde el 11-sep-2026, todos los de
      // CATEGORÍA DE EMPRESA aunque traigan vuelo — LA CATEGORÍA MANDA SOBRE
      // EL VUELO (regla del cliente; fuente única `CATEGORIAS_GASTO_EMPRESA`,
      // la MISMA que usan el Balance general y el reparto a socios). Antes
      // un OTRO/NOMINA ligado a un vuelo no salía en NINGUNA hoja de este
      // libro: el Balance ya lo cobraba a la empresa y el Libro Dinero lo
      // perdía — los dos libros del cierre no cuadraban.
      // fecha_gasto es DATE: comparación de días, sin componente horaria.
      // `vuelo:vuelo_id(folio)` es solo traza para el concepto de la fila.
      sb
        .from('gasto')
        .select(
          `id, categoria, monto, moneda, tc_gasto, fecha_gasto, notas, aeronave_id, vuelo_id${colAfac}, proveedor:proveedor_id(nombre), vuelo:vuelo_id(folio)` as 'id, categoria, monto, moneda, tc_gasto, fecha_gasto, notas, aeronave_id, vuelo_id, proveedor:proveedor_id(nombre), vuelo:vuelo_id(folio)',
        )
        .or(
          `vuelo_id.is.null,categoria.in.(${[...CATEGORIAS_GASTO_EMPRESA].join(',')})`,
        )
        // PERSONAL_DUENO fuera: es gasto personal del dueño, no del mes de
        // la empresa (réplica del Excel del cliente).
        .neq('categoria', 'PERSONAL_DUENO')
        .gte('fecha_gasto', desde)
        .lte('fecha_gasto', hasta)
        .order('fecha_gasto', { ascending: true }),
      // COMBUSTIBLE del mes (pestaña propia, 26-ago-2026): TODO el gas del
      // periodo por fecha_gasto, con o sin vuelo — mismo eje que el reparto.
      // vuelo_id + escala_id: avión del gasto por tramo (Regla B).
      sb
        .from('gasto')
        .select(
          'categoria, monto, litros, moneda, tc_gasto, fecha_gasto, lugar, notas, aeronave_id, vuelo_id, escala_id, proveedor:proveedor_id(nombre)',
        )
        .eq('categoria', 'GAS')
        .gte('fecha_gasto', desde)
        .lte('fecha_gasto', hasta)
        .order('fecha_gasto', { ascending: true }),
      // INGRESOS SIN VUELO de RESULTADO (24-sep-2026, DF §10.2 «otros
      // ingresos → ingresos no de vuelo»): fuente única compartida con el
      // Balance general. Sin la migración 20260924000004 devuelve [] sin
      // consultar nada — el libro sale byte-idéntico al de siempre.
      leerIngresosDeResultado(sb, desde, hasta),
      // CONSECUTIVO del vuelo por cliente (23-oct-2026, invariante 106):
      // columna propia del libro; best-effort y todo o nada (nunca lanza).
      consecutivosClienteDeVuelos(sb, vueloIds),
    ]);
    for (const r of [
      aeronavesRes,
      clientesRes,
      escalasRes,
      cobrosRes,
      gastosVuelo,
      gastosEmpresaYSueltos,
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
    // Tramos ACTIVOS por vuelo (ruta, clave, participación) y mapa escala →
    // avión crudo (TODOS los tramos; la herencia la aplica avionDelGasto).
    const escalasPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    const escalaPorId = new Map<string, { aeronave_id: string | null }>();
    for (const e of (escalasRes.data ?? []) as Array<Record<string, unknown>>) {
      escalaPorId.set(e.id as string, {
        aeronave_id: (e.aeronave_id as string | null) ?? null,
      });
      if (e.cancelada_at != null) continue;
      const vid = e.vuelo_id as string;
      (escalasPorVuelo.get(vid) ?? escalasPorVuelo.set(vid, []).get(vid)!).push(
        e,
      );
    }
    const vueloAvion = new Map<string, string | null>(
      vuelosPeriodo.map((v) => [
        v.id as string,
        (v.aeronave_id as string | null) ?? null,
      ]),
    );
    // Escalas referidas por cargas de GAS del periodo cuyo vuelo NO es del
    // periodo: se traen con su avión ya heredado (misma resolución).
    {
      const faltantes = [
        ...new Set(
          ((gastosGasRes.data ?? []) as Array<Record<string, unknown>>)
            .map((g) => g.escala_id as string | null)
            .filter((id): id is string => !!id && !escalaPorId.has(id)),
        ),
      ];
      if (faltantes.length > 0) {
        const { data: sueltas, error: sueltasErr } = await sb
          .from('escala')
          .select('id, aeronave_id, vuelo:vuelo_id(aeronave_id)')
          .in('id', faltantes);
        if (sueltasErr) throw new Error(sueltasErr.message);
        for (const e of (sueltas ?? []) as Array<Record<string, unknown>>) {
          const vuelo = unwrapOne(
            e.vuelo as { aeronave_id?: string | null } | null,
          );
          escalaPorId.set(e.id as string, {
            aeronave_id:
              (e.aeronave_id as string | null) ?? vuelo?.aeronave_id ?? null,
          });
        }
      }
    }
    const cobrosPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    for (const c of (cobrosRes.data ?? []) as Array<Record<string, unknown>>) {
      const vid = c.vuelo_id as string;
      (cobrosPorVuelo.get(vid) ?? cobrosPorVuelo.set(vid, []).get(vid)!).push(
        c,
      );
    }
    const gastosPorVuelo = new Map<string, Array<Record<string, unknown>>>();
    // Select dinámico (con o sin `tua_incluida`): la fila se declara a mano.
    for (const g of (gastosVuelo.data ?? []) as unknown as Array<
      Record<string, unknown>
    >) {
      const vid = g.vuelo_id as string;
      (gastosPorVuelo.get(vid) ?? gastosPorVuelo.set(vid, []).get(vid)!).push(
        g,
      );
    }
    // Etiqueta de la factura por vuelo: `etiquetasFacturaDeVuelos` (arriba).
    const facturaPorVuelo = facturasRes;
    // Cancelados sin cobros ni gastos: fuera (ver arriba). Un cancelado con
    // dinero se queda y su fila se arma con reglas propias (abajo).
    const vuelos = vuelosPeriodo.filter(
      (v) =>
        v.estado !== 'CANCELADO' ||
        cobrosPorVuelo.has(v.id as string) ||
        gastosPorVuelo.has(v.id as string),
    );

    // CLAVE del libro (fuente única `claveDinero`, 23-oct-2026, invariante
    // 106): SOLO el folio «#364». Ya no el ID por cliente («beh05-011026»,
    // invariante 68) ni el legado "vt" + primer nombre (vtchacon) ni
    // «vtservicio»: el cliente, la ruta y el consecutivo van en sus columnas.
    const claveDe = (v: Record<string, unknown>): string =>
      claveDinero({ folio: String((v.folio as number | string | null) ?? '') });
    // Vuelo de SERVICIO (tramo de taller sin pax): la regla es la ÚNICA de
    // `common/vuelo-servicio.util` (la misma del candado de cotización y del
    // CAFÉ del calendario); `escalasPorVuelo` ya trae solo tramos activos.
    const esServicio = (v: Record<string, unknown>): boolean =>
      esVueloDeServicio(escalasPorVuelo.get(v.id as string) ?? []);
    // CLAVES SIN APODO (invariante 106): las columnas CLIENTE (nombre
    // completo tal cual; «Vuelo de servicio» en un tramo de taller) y
    // CONSECUTIVO (el número del vuelo dentro de su cliente; null sin la
    // migración o si el lector no pudo leer) de TODA fila de vuelo del libro.
    const datosClienteDe = (
      v: Record<string, unknown>,
    ): { cliente: string | null; consecutivo_cliente: number | null } => ({
      cliente: esServicio(v)
        ? CLIENTE_VUELO_SERVICIO
        : (clientes.get(v.cliente_id as string) ?? null),
      consecutivo_cliente: consecutivosCliente.get(v.id as string) ?? null,
    });

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
    // Σ pagado DE VERDAD al vendedor (las DOS categorías, apareados o de
    // solo-egreso): se descuenta de otros ingresos en la hoja utilidades.
    // Desde el 13-oct-2026 (invariante 61) es lo ÚNICO que se descuenta: ya
    // no existe la provisión de los vuelos sin gasto real.
    let comisionPagadaMxn = 0;
    let hayPagoVendedorReal = false;
    // Σ MXN de los pagos «Comisión del vendedor (avión)» de vuelos que carga
    // un avión (13-oct-2026, invariante 61): SOLO informativa (llave
    // `utilidades_comision_vendedor_avion_mxn`): ya está dentro de
    // `comisionPagadaMxn` — la diferencia esperada con el Balance general.
    let comisionAvionMxn = 0;
    // CIERRE DE MES (invariante 89): marcas por vuelo y bloque raíz `cierre`.
    const cierreDinero = contable
      ? await this.cierreLibroDinero({
          desde,
          hasta,
          vuelos,
          cobrosPorVuelo,
          clientes,
          aviones,
          claveDe,
        })
      : null;
    for (const v of vuelos) {
      const vid = v.id as string;
      // REGLA B (28-ago-2026): participación de cada avión en la venta del
      // avión de este vuelo (fuente única). Externos no se reparten (sin
      // avión de flota): factor 1 al avión de referencia si lo hubiera.
      const part = participacionPorAeronave(
        v,
        v.es_externo === true ? [] : (escalasPorVuelo.get(vid) ?? []),
      );
      const avionReporta = avionQueReporta(part);
      // Filas de la hoja 1: una por avión participante; sin avión resoluble
      // (externo sin referencia / vuelo sin avión) una sola fila sin
      // matrícula, como siempre.
      const filasAvion: Array<{
        aid: string | null;
        factor: number;
        reporta: boolean;
      }> =
        part.factores.size > 0
          ? [...part.factores.keys()].map((aid) => ({
              aid,
              factor: factorDe(part, aid),
              reporta: aid === avionReporta,
            }))
          : [{ aid: null, factor: 1, reporta: true }];
      // Parte de un avión de un monto del vuelo: repartirUsd (Σ partes ==
      // monto exacto); con un solo avión (o sin avión) es el monto completo.
      const parteDe = (
        monto: number | null,
        aid: string | null,
      ): number | null => {
        if (monto == null) return null;
        if (aid == null || part.factores.size <= 1) return monto;
        return repartirUsd(monto, part).get(aid) ?? 0;
      };
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
      // son la venta del AVIÓN (tiempo + ajuste + su IVA). TUAS/extras/
      // pernocta/comisión del vendedor y su IVA son ingreso de VuelaTour y
      // viven en la hoja "otros ingresos" (Regla A: la comisión ya no es
      // costo del avión — ninguna columna de esta hoja la lleva). Partición
      // = fuente única (particionIngresoVuelo). El total del CLIENTE se
      // conserva en total_cliente_* y "me deben" sigue sobre ese total (la
      // deuda del cliente es completa).
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
        ? cobrosEnUsd(cobrosPorVuelo.get(v.id as string) ?? [], tc, tc)
            .total_usd
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
      // Total del CLIENTE en MXN: FUENTE ÚNICA `totalMxnDeVuelo` (17-sep-2026)
      // — se LEE `monto_total_mxn` (el número exacto que el cliente vio, con
      // los renglones nativos en pesos incluidos) y solo sin él se cae a
      // usd × TC. Recalcularlo aquí era lo que hacía que el Libro Dinero
      // dijera 99,999.81 donde la cotización decía 100,000.00.
      const totalMxnCalc =
        totalMxnDeVuelo(v) ??
        (totalUsd != null && tc != null ? totalUsd * tc : null);
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
      // Parte VuelaTour del vuelo (USD y MXN): la lleva UNA sola fila (la del
      // avión que reporta); 0 sin partición (sin precio / cancelado / sin
      // TC). En MXN se cierra por diferencia contra el total del cliente
      // (misma cifra que cuadra la hoja "otros ingresos").
      const vtUsd = conPrecio && p.vuelatour_usd > 0 ? p.vuelatour_usd : 0;
      const vtMxn =
        conPrecio &&
        p.vuelatour_usd > 0 &&
        totalMxnCalc != null &&
        ventaMxn != null
          ? r2n(r2n(totalMxnCalc) - ventaMxn)
          : 0;
      // El schema no tiene columna de estado: el cancelado se marca en la
      // RUTA (columna de texto que ya pinta la hoja) y en el status de cobro.
      const rutaBase = rutaDe(v.id as string);
      const ruta = esCancelado
        ? rutaBase
          ? `${rutaBase} · CANCELADO`
          : 'CANCELADO'
        : rutaBase;

      // Una fila por avión participante (Regla B), COHERENTE por sí sola:
      // venta, IVA y horas cobradas con SU parte (repartirUsd / 4 decimales
      // en horas; Σ filas == vuelo al centavo); total del cliente, cobros y
      // "me deben" con la MISMA partición — la fila que reporta lleva su
      // parte del avión + la parte VuelaTour, las demás solo su parte del
      // avión (nunca el total completo junto a cobros repartidos). Con un
      // solo avión: la fila de siempre, idéntica.
      const horasPorAvion =
        horas != null && part.factores.size > 1
          ? repartirHoras(horas, part)
          : null;
      for (const fa of filasAvion) {
        const avion = fa.aid ? aviones.get(fa.aid) : undefined;
        const ventaMxnParte = parteDe(ventaMxn, fa.aid);
        const ivaMxnParte = parteDe(ivaMxn, fa.aid);
        const horasParte =
          horasPorAvion && fa.aid ? (horasPorAvion.get(fa.aid) ?? 0) : horas;
        // Cobros de ESTA fila — fuente única `parteFilaDeCobro` (la misma
        // del balance por avión): la parte del avión de cada cobro
        // (prorrateo con factor_avion de la partición — misma proporción
        // que el reparto de dueños — repartida entre los aviones) y, solo
        // en la fila que reporta, la parte VuelaTour cerrada por
        // diferencia: Σ filas == cobro al centavo. Sin partición (cancelado
        // / sin precio) todo el cobro es del avión y se reparte; con un
        // solo avión, el cobro tal cual.
        const cobrosParte = cobros.map((c) => {
          if (c.monto_mxn == null) return { fecha: c.fecha, monto_mxn: null };
          return {
            fecha: c.fecha,
            monto_mxn: parteFilaDeCobro(
              c.monto_mxn,
              conPrecio ? p : null,
              part,
              fa.aid,
              fa.reporta,
              esCancelado,
            ),
          };
        });
        const totalCobrosParte = cobrosParte.reduce(
          (s, c) => s + (c.monto_mxn ?? 0),
          0,
        );
        // Total del CLIENTE de esta fila (ver arriba). Cancelado / sin
        // precio: la cotización (informativa) repartida como la venta.
        const totalClienteUsd =
          esCancelado || !conPrecio
            ? parteDe(totalUsd, fa.aid)
            : r2n((parteDe(ventaUsd, fa.aid) ?? 0) + (fa.reporta ? vtUsd : 0));
        const totalClienteMxn =
          esCancelado || !conPrecio
            ? parteDe(totalMxnCalc, fa.aid)
            : ventaMxnParte != null
              ? r2n(ventaMxnParte + (fa.reporta ? vtMxn : 0))
              : null;
        // "Me deben" de la fila = su total del cliente − sus cobros.
        // Cancelado: nada por cobrar (lo retenido ES la venta).
        const meDebenParte = esCancelado
          ? 0
          : totalClienteMxn != null
            ? Math.max(0, r2n(totalClienteMxn - totalCobrosParte))
            : null;
        const sufijoClave = part.multi_avion
          ? ` (${pctLabel(fa.factor)} ${avion?.matricula ?? '?'})`
          : '';
        filas.push({
          clave: `${claveDe(v)}${sufijoClave}`,
          // CLAVES SIN APODO (invariante 106): cliente y consecutivo en sus
          // columnas; `servicio: true` SOLO en el vuelo de servicio (antes
          // su clave era «vtservicio»).
          ...datosClienteDe(v),
          ...(esServicio(v) ? { servicio: true as const } : {}),
          matricula: avion?.matricula ?? (v.es_externo ? 'EXTERNO' : null),
          color: avion?.color ?? null,
          fecha: (v.fecha_vuelo as string) ?? null,
          ruta,
          // Un vuelo que VIENE de otro mes (invariante 89) no trae horas: se
          // quedaron en el mes en que se voló.
          tiempo: cierreDinero?.venidos.has(vid) ? null : horasParte,
          venta_hr_usd: r2(tarifa),
          venta_hr_mxn: r2(tarifa != null && tc != null ? tarifa * tc : null),
          iva_hr_usd: r2(ivaHr),
          venta_hr_masiva_usd: r2(
            tarifa != null ? tarifa + (ivaHr ?? 0) : null,
          ),
          // Venta del AVIÓN (regla 6); el total del cliente va aparte.
          total_cobrado_usd: r2(parteDe(ventaUsd, fa.aid)),
          iva_total_usd: r2(parteDe(ivaUsd, fa.aid)),
          // TC con la precisión canónica (6 decimales): la columna del libro
          // dice el MISMO número que la hoja de la cotización.
          tc_venta: tc != null ? round6(tc) : null,
          total_cobrado_mxn: r2(ventaMxnParte),
          iva_total_mxn: r2(ivaMxnParte),
          total_siva_mxn: r2(
            ventaMxnParte != null ? ventaMxnParte - (ivaMxnParte ?? 0) : null,
          ),
          // Cancelado: la cotización se conserva aquí solo como referencia.
          // Multi-avión: parte del avión (+ parte VuelaTour en la fila que
          // reporta); Σ filas == total del cliente.
          total_cliente_usd: r2(totalClienteUsd),
          total_cliente_mxn: r2(totalClienteMxn),
          status_cobro: esCancelado
            ? 'CANCELADO'
            : v.cobrado === true
              ? 'COBRADO'
              : 'PENDIENTE',
          cobros: cobrosParte,
          total_cobros_mxn: r2(totalCobrosParte),
          me_deben_mxn: r2(meDebenParte),
          factura_vuelatour: facturaPorVuelo.get(v.id as string) ?? null,
          participacion: fa.factor,
          multi_avion: part.multi_avion,
          // CIERRE DE MES (invariante 89, ADITIVOS al final): solo con la
          // migración.
          ...(cierreDinero
            ? (cierreDinero.marcas.get(vid) ?? {
                cierre_marca: null,
                diferido_de: null,
                diferido_a: null,
              })
            : {}),
        });
      }

      // ===== Hoja 2: otros ingresos (TUAs/extras/pernocta/comisión del
      // vendedor + su IVA = la parte VuelaTour de la partición, en MXN con el
      // TC de venta). Sale UNA vez por vuelo (no se reparte entre aviones).
      // El egreso solo se llena cuando el mapeo es directo (TUAS ↔ gasto
      // TUAS del vuelo; comisión ↔ gasto real «Comisión del vendedor»); el
      // resto lo concilia el equipo a mano, como en su libro.
      //
      // Líneas PRE-IVA: del desglose canónico v1.3 cuando existe (una línea
      // TUAS por aeropuerto, extras, pernocta, comisión del vendedor); sin
      // snapshot, de las columnas del vuelo (misma fuente que la partición).
      // Partición INCONSISTENTE (desglose que no cuadra: todo al avión) →
      // SIN líneas: la hoja 1 ya lleva el total completo y repetirlas
      // contaría doble en utilidades; el pre-cierre lo avisa
      // (extras_sin_desglose). El TUA PAGADO del vuelo sale de todos modos
      // (fila de solo-egreso, abajo).
      //
      // COMISIÓN DEL VENDEDOR (Regla A, 28-ago-2026 tarde): ingreso de
      // VuelaTour "como un extra" con etiqueta corta "comisión vendedor
      // (Nombre)"; grava, y su IVA se PLIEGA en la misma línea (la línea
      // vale exactamente `pagoVendedorUsd`) para que el egreso apareado — el
      // pago al vendedor = comisión + IVA (neto de VuelaTour = precio base,
      // regla 23-jul) — cierre la fila en 0.
      const nombreVendedor =
        (v.comision_vendedor_nombre as string | null)?.trim() ||
        (
          v.calculo_snapshot as {
            meta?: { comision_vendedor_nombre?: string | null } | null;
          } | null
        )?.meta?.comision_vendedor_nombre?.trim() ||
        null;
      const etiquetaComision = nombreVendedor
        ? `comisión vendedor (${nombreVendedor})`
        : 'comisión vendedor';
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
            if (!/^(TUAS|EXTRA|PERNOCTA|COMISION_VENDEDOR)/.test(claveLinea))
              continue;
            const montoUsd = num(linea.monto_usd);
            if (montoUsd == null || montoUsd === 0) continue;
            lineasVT.push({
              clave: claveLinea,
              concepto:
                claveLinea === 'COMISION_VENDEDOR'
                  ? etiquetaComision
                  : String(linea.concepto ?? claveLinea).toLowerCase(),
              monto_usd: montoUsd,
            });
          }
        } else {
          for (const [clave, concepto, montoUsd] of [
            ['TUAS', 'tuas', p.tuas_usd],
            ['EXTRA', 'extras', p.extras_usd],
            ['PERNOCTA', 'pernocta', p.pernocta_usd],
            ['COMISION_VENDEDOR', etiquetaComision, p.comision_vendedor_usd],
          ] as const) {
            if (montoUsd !== 0)
              lineasVT.push({ clave, concepto, monto_usd: montoUsd });
          }
        }
        // Parte VuelaTour sin línea pre-IVA (solo IVA/redondeo residual):
        // una línea propia para no perder el cuadre de la hoja.
        if (lineasVT.length === 0) {
          lineasVT.push({
            clave: 'RESIDUO',
            concepto: 'iva y redondeo de tuas/extras',
            monto_usd: p.vuelatour_usd,
          });
        }
      }
      // IVA PLEGADO por línea — misma regla que "Otros movimientos" del
      // Balance general (buildOtrosMovimientos): la línea de comisión vale
      // EXACTAMENTE pagoVendedorUsd(p) (comisión + su IVA, fuente única); el
      // resto del IVA de VuelaTour (iva_vuelatour_usd −
      // ivaComisionVendedorUsd) se prorratea entre TUAS/extras gravados; el
      // residuo (centavos del prorrateo, redondeo) va a la ÚLTIMA línea que
      // NO sea la comisión, así Σ líneas == vuelatour_usd exacto y la línea
      // de comisión vale exactamente lo cobrado por ella (contra eso se
      // compara el gasto real: «faltan/excede»). lineasVT solo existe con
      // partición consistente
      // (inconsistente → vuelatour_usd = 0). Sin desglose canónico (fuente
      // 'columnas') el prorrateo es estimado: TUAS y extras como gravados.
      const esComision = (l: { clave: string }) =>
        l.clave === 'COMISION_VENDEDOR';
      const gravada = (l: { clave: string; concepto: string }) =>
        l.clave === 'TUAS' ||
        l.clave === 'COMISION_VENDEDOR' ||
        (l.clave === 'EXTRA' && !/\(sin iva\)\s*$/i.test(l.concepto));
      const pagoVendedor = pagoVendedorUsd(p);
      const comisionLineasUsd = r2n(
        lineasVT.filter(esComision).reduce((a, l) => a + l.monto_usd, 0),
      );
      const baseGravada = r2n(
        lineasVT
          .filter((l) => gravada(l) && !esComision(l))
          .reduce((a, l) => a + l.monto_usd, 0),
      );
      const ivaResto = r2n(p.iva_vuelatour_usd - ivaComisionVendedorUsd(p));
      const lineasConIva = lineasVT.map((l) => ({
        ...l,
        total_usd: esComision(l)
          ? // Normalmente UNA línea (motor v1.3): lleva el pago entero; con
            // varias, proporcional a su monto.
            comisionLineasUsd > 0
            ? r2n((pagoVendedor * l.monto_usd) / comisionLineasUsd)
            : l.monto_usd
          : r2n(
              l.monto_usd +
                (gravada(l) && baseGravada > 0
                  ? r2n((ivaResto * l.monto_usd) / baseGravada)
                  : 0),
            ),
      }));
      if (lineasConIva.length > 0) {
        const receptor =
          [...lineasConIva].reverse().find((l) => !esComision(l)) ??
          lineasConIva[lineasConIva.length - 1];
        const residuo = r2n(
          p.vuelatour_usd - lineasConIva.reduce((a, l) => a + l.total_usd, 0),
        );
        if (Math.abs(residuo) >= 0.005)
          receptor.total_usd = r2n(receptor.total_usd + residuo);
      }
      // A MXN con el TC de venta. El RESIDUO CAMBIARIO (Σ round2 por línea ≠
      // parte VuelaTour en MXN = total del cliente − venta del avión) se
      // absorbe en la última línea que NO sea la comisión (si la comisión es
      // la única, en ella): por vuelo
      // y en la hoja completa Σ venta avión + Σ otros ingresos == Σ total
      // cliente AL CENTAVO.
      const lineasMxn = lineasConIva.map((l) => ({
        ...l,
        ingreso_mxn: tc != null ? r2n(l.total_usd * tc) : null,
      }));
      if (tc != null && vtMxn !== 0 && lineasMxn.length > 0) {
        const residuoMxn = r2n(
          vtMxn - lineasMxn.reduce((a, l) => a + (l.ingreso_mxn ?? 0), 0),
        );
        if (residuoMxn !== 0) {
          const receptor =
            [...lineasMxn]
              .reverse()
              .find((l) => !esComision(l) && l.ingreso_mxn != null) ??
            [...lineasMxn].reverse().find((l) => l.ingreso_mxn != null);
          if (receptor && receptor.ingreso_mxn != null)
            receptor.ingreso_mxn = r2n(receptor.ingreso_mxn + residuoMxn);
        }
      }
      const gastosV = gastosPorVuelo.get(v.id as string) ?? [];
      // Regla ÚNICA de conversión a MXN de lo PAGADO en este vuelo (TUA
      // pagado y pago al vendedor): MXN directo; USD × tc_gasto o, sin él,
      // el TC de venta; sin NINGÚN TC ⇒ null (no se suma en falso).
      const pagadoAMxn = (
        monto: number,
        g: Record<string, unknown>,
      ): number | null => {
        const tcg = pos(g.tc_gasto) ?? tc;
        return g.moneda === 'MXN' ? monto : tcg != null ? monto * tcg : null;
      };
      // PAGO REAL AL VENDEDOR (invariante 31): gastos del vuelo de las DOS
      // categorías (invariante 61: la caja de VuelaTour resta los dos) con la
      // MISMA regla que su TUA pagado. Con n = 0 la fila de comisión no lleva
      // egreso (sin provisión). `pagosAv` y `avionLaCarga` SOLO deciden
      // textos y la llave informativa, NUNCA dinero: la «(avión)» la carga un
      // avión en el Balance general si el vuelo está en su universo
      // (`pagoVendedorAvionEnUniverso`, el MISMO criterio de los libros) y
      // algún avión tiene parte de la venta.
      const aMxnPagoVendedor = (g: GastoPagoVendedorRow): number | null =>
        pagadoAMxn(num(g.monto) ?? 0, g as unknown as Record<string, unknown>);
      const pagosVend = pagosVendedorDeVuelo(
        gastosV as unknown as GastoPagoVendedorRow[],
        aMxnPagoVendedor,
        'AMBOS',
      );
      const pagosAv = pagosVendedorDeVuelo(
        gastosV as unknown as GastoPagoVendedorRow[],
        aMxnPagoVendedor,
        'AVION',
      );
      const avionLaCarga =
        pagoVendedorAvionEnUniverso({
          estado: (v.estado as string | null) ?? null,
          cobros: cobrosPorVuelo.get(vid) ?? [],
          tcVenta: tc,
        }) && [...part.factores.values()].some((f) => f > 0);
      if (pagosVend.n > 0) hayPagoVendedorReal = true;
      if (pagosAv.n > 0 && avionLaCarga) {
        comisionAvionMxn += pagosAv.pagadoMxn ?? 0;
      }
      const lineasComisionMxn = lineasMxn.filter(esComision);
      const lineaComisionMxn =
        lineasComisionMxn.length > 0 &&
        lineasComisionMxn.every((l) => l.ingreso_mxn != null)
          ? r2n(lineasComisionMxn.reduce((a, l) => a + (l.ingreso_mxn ?? 0), 0))
          : null;
      let egresoPagoVendedorAsignado = false;
      // TUA PAGADO del vuelo (categoría TUAS entera + parte TUA EMBEBIDA en
      // facturas de aeródromo leídas por IA — caso ASUR "aterrizaje,
      // pernocta, TUA y plataforma"), calculado UNA vez por vuelo, a MXN con
      // la MISMA regla del Balance general: MXN directo; USD × tc_gasto o,
      // sin él, el TC de venta; sin NINGÚN TC no se suma en falso — queda
      // como nota en el concepto. FUENTE ÚNICA `trasladosEmbebidosDeGasto`: misma
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
      // EXTENSIÓN DE HORARIO PAGADA (1-oct-2026, caso #192): igual que el
      // TUA — parte «extensión y/o antelación de horario» de las facturas
      // de aeródromo (fuente única `trasladosEmbebidosDeGasto`, la MISMA del
      // Balance general y del reparto), egreso apareado con la línea EXTRA
      // de extensión cobrada o fila de solo-egreso. Como el TUA, se ANOTA
      // (no se descuenta de utilidades: solo cuentan los ingresos).
      let extensionPagadaMxn = 0;
      let extensionPagadaHubo = false;
      let extensionSinTc = false;
      let fechaExtension: string | null = null;
      for (const g of gastosV) {
        // COROLARIO de "la categoría de EMPRESA manda" (11-sep-2026): un
        // OTRO/NOMINA/GASOLINA/FIJO/VISITA con vuelo ya restó ENTERO en la
        // hoja "otros gastos"; sacar además su parte TUA embebida como
        // egreso aquí la contaría DOS VECES en el mismo libro. (TUAS no es
        // categoría de empresa: su apareo cobrado↔pagado sigue igual.)
        if (categoriaEsDeEmpresa(g.categoria as string | null)) continue;
        // FUENTE ÚNICA de la TUA pagada (13-oct-2026, invariante 66): TUAS =
        // el gasto entero; el resto = la embebida con la TUA de la oficina.
        const traslados = trasladosPagadosDeGasto({
          vuelo_id: g.vuelo_id as string | null,
          categoria: g.categoria as string | null,
          monto: g.monto as string | number | null,
          propina: g.propina as string | number | null,
          valor_ia_extraido: g.valor_ia_extraido,
          notas: (g.notas as string | null) ?? null,
          tua_incluida:
            (g.tua_incluida as string | number | null | undefined) ?? null,
        });
        if (traslados.tua > 0) {
          const parteMxn = pagadoAMxn(traslados.tua, g);
          if (parteMxn == null) {
            // USD sin ningún TC: rastro en el concepto, jamás sumado en falso.
            tuaSinTc = true;
          } else if (parteMxn > 0) {
            tuaPagadoMxn += parteMxn;
            tuaPagadoHubo = true;
            fechaTua ??= (g.fecha_gasto as string) ?? null;
          }
        }
        if (traslados.extension > 0) {
          const parteMxn = pagadoAMxn(traslados.extension, g);
          if (parteMxn == null) {
            extensionSinTc = true;
          } else if (parteMxn > 0) {
            extensionPagadaMxn += parteMxn;
            extensionPagadaHubo = true;
            fechaExtension ??= (g.fecha_gasto as string) ?? null;
          }
        }
      }
      const conceptoExtensionPagada = (extra?: string): string => {
        const notas = [
          extensionSinTc
            ? extensionPagadaHubo
              ? 'parcial: USD sin TC'
              : 'USD sin TC'
            : null,
          extra ?? null,
        ].filter(Boolean);
        return notas.length
          ? `${CONCEPTO_EXTENSION_PAGADA} (${notas.join('; ')})`
          : CONCEPTO_EXTENSION_PAGADA;
      };
      let egresoExtensionAsignado = false;
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
      for (const linea of lineasMxn) {
        const claveLinea = linea.clave;
        let egresoMxn: number | null = null;
        let conceptoEgreso: string | null = null;
        let fechaEgreso: string | null = null;
        let notaEgreso: string | null = null;
        const ingresoMxn = linea.ingreso_mxn;
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
        // Extensión de servicios cobrada ↔ extensión de horario pagada
        // (1-oct-2026, misma mecánica que el TUA: solo la PRIMERA línea EXTRA
        // de extensión lleva el egreso).
        if (
          claveLinea === 'EXTRA' &&
          esExtension(linea.concepto) &&
          !egresoExtensionAsignado &&
          (extensionPagadaHubo || extensionSinTc)
        ) {
          egresoMxn = extensionPagadaHubo ? r2(extensionPagadaMxn) : null;
          conceptoEgreso = conceptoExtensionPagada();
          fechaEgreso = fechaExtension;
          egresoExtensionAsignado = true;
        }
        // Comisión cobrada ↔ pago al vendedor (Regla A; invariante 31 desde
        // el 28-sep-2026). Lo que aquí sale como egreso se descuenta de
        // "otros ingresos" en utilidades (no es gasto de ninguna otra hoja:
        // ninguna de las dos categorías entra a "otros gastos").
        // SIN pago real (n = 0) NO hay egreso (13-oct-2026, API 0.0.74,
        // invariante 61: ya no existe la provisión en ningún libro): la fila
        // conserva el ingreso cobrado y su remanente es ese ingreso (la
        // fórmula de siempre con egreso null). Este libro es la caja de
        // VuelaTour: con pagos los resta enteros aquí UNA vez (las DOS
        // categorías), en todo vuelo; el concepto y la nota dicen qué parte
        // es «(avión)» y si la carga un avión en el Balance general.
        if (esComision(linea)) {
          if (pagosVend.n > 0 && !egresoPagoVendedorAsignado) {
            // GASTO REAL: Σ de los pagos del vuelo (no se provisiona ningún
            // faltante: la diferencia con lo cobrado se VE como
            // «faltan/excede»), en la PRIMERA línea de comisión.
            // Remanente: fórmula de siempre.
            egresoMxn =
              pagosVend.pagadoMxn != null ? r2(pagosVend.pagadoMxn) : null;
            conceptoEgreso =
              conceptoPagoVendedorReal({
                etiquetaComision,
                pagos: pagosVend,
                lineaMxn: lineaComisionMxn,
              }) + sufijoParteAvionDinero(pagosAv, avionLaCarga);
            fechaEgreso = pagosVend.fecha;
            notaEgreso =
              NOTA_PAGO_VENDEDOR_REAL +
              notaParteAvionDinero(pagosAv, avionLaCarga);
            comisionPagadaMxn += egresoMxn ?? 0;
            egresoPagoVendedorAsignado = true;
          }
        }
        otrosIngresos.push({
          clave: claveDe(v),
          // CLAVES SIN APODO (invariante 106): cliente, consecutivo y la
          // ruta de la hoja de vuelos en las filas del vuelo.
          ...datosClienteDe(v),
          fecha_vuelo: (v.fecha_vuelo as string) ?? null,
          ruta: rutaBase,
          concepto_egreso: conceptoEgreso,
          egreso_mxn: egresoMxn,
          fecha_egreso: fechaEgreso,
          nota_egreso: notaEgreso,
          concepto_ingreso: `${linea.concepto}${
            ingresoMxn == null ? ' (USD sin TC de venta)' : ''
          }`,
          ingreso_mxn: ingresoMxn,
          fecha_ingreso: (v.fecha_vuelo as string) ?? null,
          remanente_mxn:
            ingresoMxn != null ? r2(ingresoMxn - (egresoMxn ?? 0)) : null,
          factura: facturaPorVuelo.get(v.id as string) ?? null,
        });
      }
      // (El IVA de TUAS/extras ya viaja PLEGADO en cada línea de arriba,
      // como en Otros movimientos del Balance general: no hay fila aparte
      // "iva de tuas/extras"; el cuadre por vuelo — Σ venta avión + Σ otros
      // ingresos == total del cliente — lo garantiza el residuo cambiario.)

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
          ...datosClienteDe(v),
          fecha_vuelo: (v.fecha_vuelo as string) ?? null,
          ruta: rutaBase,
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

      // EXTENSIÓN DE HORARIO pagada SIN línea de extensión cobrada (#190,
      // #314): fila de SOLO-egreso, idéntica en trato al TUA sin línea
      // (ingreso null ⇒ utilidades no cambian; el total de egresos sí).
      if ((extensionPagadaHubo || extensionSinTc) && !egresoExtensionAsignado) {
        const egreso = extensionPagadaHubo ? r2(extensionPagadaMxn) : null;
        otrosIngresos.push({
          clave: claveDe(v),
          ...datosClienteDe(v),
          fecha_vuelo: (v.fecha_vuelo as string) ?? null,
          ruta: rutaBase,
          concepto_egreso: conceptoExtensionPagada(
            esCancelado ? 'vuelo cancelado' : 'sin línea de extensión cobrada',
          ),
          egreso_mxn: egreso,
          fecha_egreso: fechaExtension,
          concepto_ingreso: null,
          ingreso_mxn: null,
          fecha_ingreso: null,
          remanente_mxn: egreso != null ? r2(-egreso) : null,
          factura: facturaPorVuelo.get(v.id as string) ?? null,
        });
      }

      // PAGO REAL al vendedor SIN línea de comisión que lo aparee (vuelo sin
      // comisión cotizada, CANCELADO o partición inconsistente): fila de
      // SOLO-egreso con el motivo de `motivoSinLineaComision` (MISMA regla y
      // mismo concepto que el Balance general). A diferencia del TUA sin
      // línea, SÍ se descuenta de "otros ingresos" en utilidades: es dinero
      // de VuelaTour que no está en ninguna otra hoja.
      if (pagosVend.n > 0 && !egresoPagoVendedorAsignado) {
        const motivo = motivoSinLineaComision({
          cancelado: esCancelado,
          inconsistente: p.inconsistente,
          comisionVendedorUsd: p.comision_vendedor_usd,
        });
        const egreso =
          pagosVend.pagadoMxn != null ? r2(pagosVend.pagadoMxn) : null;
        otrosIngresos.push({
          clave: claveDe(v),
          ...datosClienteDe(v),
          fecha_vuelo: (v.fecha_vuelo as string) ?? null,
          ruta: rutaBase,
          concepto_egreso:
            conceptoPagoVendedorReal({
              etiquetaComision,
              pagos: pagosVend,
              lineaMxn: null,
              sinLinea: motivo,
            }) + sufijoParteAvionDinero(pagosAv, avionLaCarga),
          egreso_mxn: egreso,
          fecha_egreso: pagosVend.fecha,
          nota_egreso:
            NOTA_PAGO_VENDEDOR_SIN_LINEA +
            notaParteAvionDinero(pagosAv, avionLaCarga),
          concepto_ingreso: null,
          ingreso_mxn: null,
          fecha_ingreso: null,
          remanente_mxn: egreso != null ? r2(-egreso) : null,
          factura: facturaPorVuelo.get(v.id as string) ?? null,
        });
        comisionPagadaMxn += egreso ?? 0;
      }
    }

    // ===== Hoja «Otros ingresos», AL FINAL: los ingresos sin vuelo de
    // RESULTADO registrados en Ingresos (ING-n; orden fecha, folio). Los
    // anticipos y las aportaciones NO están aquí (no son resultado: el
    // anticipo cuenta como cobro del vuelo al aplicarse). Su comisión
    // bancaria es egreso de la fila y se RESTA en utilidades (mismo trato
    // que el pago al vendedor: no es gasto de ninguna otra hoja; sin
    // restarla, utilidades y el TOTAL remanente del Balance general dirían
    // números distintos). =====
    //
    // INGRESO ASIGNADO A UN AVIÓN (13-oct-2026, API 0.0.75, invariante 67):
    // un ingreso con avión cuenta UNA vez: en su avión (balance, reparto y su
    // columna OTROS INGRESOS de 'utilidades'), nunca en OTROS INGRESOS de
    // VuelaTour. Partición ÚNICA `partirIngresosPorAvion`: este bucle corre
    // solo sobre los de VuelaTour (sus filas y `comisionIngresosMxn`, byte a
    // byte las de siempre) y los del avión van APARTE en
    // `otros_ingresos_avion`, sin tocar `otrosIngresos` ni la comisión: así
    // `utilidades_otros_ingresos_mxn` los excluye ÍNTEGROS por construcción.
    const partidos = partirIngresosPorAvion(ingresosResultado);
    let comisionIngresosMxn = 0;
    for (const ing of partidos.empresa) {
      const f = filaLibroDeIngreso(ing);
      if (!f) continue;
      otrosIngresos.push({
        clave: f.clave,
        fecha_vuelo: null,
        concepto_egreso: f.concepto_egreso,
        egreso_mxn: f.egreso_mxn,
        fecha_egreso:
          f.egreso_mxn != null || f.concepto_egreso ? f.fecha : null,
        nota_egreso: null,
        concepto_ingreso: f.concepto_ingreso,
        ingreso_mxn: f.ingreso_mxn,
        fecha_ingreso: f.fecha,
        remanente_mxn: f.remanente_mxn,
        factura: null,
      });
      if (f.ingreso_mxn != null && f.egreso_mxn != null) {
        comisionIngresosMxn += f.egreso_mxn;
      }
    }
    // Los ASIGNADOS a un avión, en el orden del lector (fecha, folio): la
    // MISMA fila de `filaLibroDeIngreso` + su matrícula y color, y su
    // remanente (ingreso − comisión) acreditado a SU avión en 'utilidades'.
    const otrosIngresosAvion: DineroOtroIngresoFilaPayload[] = [];
    const otrosIngresosPorAvion = new Map<string, number>();
    for (const ing of ingresosResultado.filter(ingresoEsDelAvion)) {
      const f = filaLibroDeIngreso(ing);
      if (!f) continue;
      otrosIngresosAvion.push({
        clave: f.clave,
        fecha_vuelo: null,
        concepto_egreso: f.concepto_egreso,
        egreso_mxn: f.egreso_mxn,
        fecha_egreso:
          f.egreso_mxn != null || f.concepto_egreso ? f.fecha : null,
        nota_egreso: null,
        concepto_ingreso: f.concepto_ingreso,
        ingreso_mxn: f.ingreso_mxn,
        fecha_ingreso: f.fecha,
        remanente_mxn: f.remanente_mxn,
        factura: null,
        matricula: ing.matricula ?? null,
        avion_color: ing.aeronave_color ?? null,
      });
      if (ing.aeronave_id && f.remanente_mxn != null) {
        otrosIngresosPorAvion.set(
          ing.aeronave_id,
          (otrosIngresosPorAvion.get(ing.aeronave_id) ?? 0) + f.remanente_mxn,
        );
      }
    }

    // ===== Hoja 3: otros gastos del mes, con acumulado =====
    // Universo (11-sep-2026): los sueltos SIN vuelo de siempre + TODOS los
    // de CATEGORÍA DE EMPRESA aunque traigan vuelo o avión sellado (la
    // categoría manda sobre el vuelo — misma regla y misma fuente única que
    // el Balance general y el reparto a socios).
    // Reparto MANUAL (gasto_reparto, 26-ago-2026): la FILA del libro y el
    // acumulado NO cambian (el pago es uno); solo la ATRIBUCIÓN por avión de
    // la hoja utilidades usa los parciales — el remanente queda en el
    // acumulado general (gasto de la EMPRESA VuelaTour), sin acreditarse a
    // ningún avión. Misma regla que el reparto a socios y el balance.
    const repartosDinero = await fetchRepartos(
      sb,
      (
        (gastosEmpresaYSueltos.data ?? []) as Array<Record<string, unknown>>
      ).map((g) => g.id as string),
    );
    const otrosGastos: DineroOtroGastoFilaPayload[] = [];
    let acumulado = 0;
    const indirectosPorAvion = new Map<string, number>();
    const otrosPorAvion = new Map<string, number>();
    const permisosPorAvion = new Map<string, number>();
    for (const g of (gastosEmpresaYSueltos.data ?? []) as Array<
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
      // Pago de AFAC marcado (invariante 90): se LISTA (caja real del mes)
      // pero no se acredita a ningún avión (lo paga VuelaTour).
      const pagoAfac = esPagoAfac(g);
      const monto = num(g.monto) ?? 0;
      const tcg = pos(g.tc_gasto);
      const mxn = g.moneda === 'MXN' ? monto : tcg != null ? monto * tcg : null;
      const prov = unwrapOne(g.proveedor as { nombre?: string } | null)?.nombre;
      const nota = ((g.notas as string | null) ?? '').split('\n')[0].trim();
      const filasReparto = repartosDinero.get(g.id as string);
      // Referencia del vuelo (11-sep-2026, espejo del Balance general): un
      // gasto de EMPRESA ligado a un vuelo entra ENTERO en esta hoja; el
      // folio queda como traza para que nadie crea que se perdió — el dinero
      // NO es del vuelo ni de su avión.
      const folioRef = unwrapOne(g.vuelo as { folio?: unknown } | null)?.folio;
      const referenciaVuelo =
        g.vuelo_id == null
          ? null
          : typeof folioRef === 'number' || typeof folioRef === 'string'
            ? `vuelo #${folioRef}`
            : 'vuelo sin folio';
      const concepto = [
        etiquetaCategoriaGasto(g.categoria as string | null),
        prov ?? null,
        nota || null,
        referenciaVuelo,
        filasReparto
          ? `repartido entre ${filasReparto.length} avión(es)`
          : null,
        mxn == null ? '(USD sin TC — no suma)' : null,
        esTuas ? '(TUA pagado — no resta: Otros movimientos)' : null,
        pagoAfac ? SUFIJO_DINERO_PAGO_AFAC : null,
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
      //  - Parcial de un reparto MANUAL (FIJO/OTRO/GASOLINA/VISITA de la
      //    empresa repartidos a mano) → otros gastos: la parte de este
      //    avión de un gasto administrativo. EXCEPCIÓN (29-ago-2026,
      //    reclasificación COSMÉTICA, espejo del Balance por avión): el
      //    parcial de categoría INDIRECTO — y NOMINA (repartible desde el
      //    29-ago) — acredita a "gastos indirectos" — el cliente los busca
      //    por su categoría; el cuadre no cambia (utilidades resta AMBOS
      //    cortes), solo cambia de columna.
      //  - aeronave_id DIRECTO sin vuelo (INDIRECTO, REFACCION, SERVICIOS,
      //    OPERACIONES, …) → gastos indirectos: no se ligan a un vuelo pero
      //    sí al avión.
      //  - GAS (pestaña propia) y TUAS (regla 7) nunca se acreditan.
      //  - CATEGORÍA DE EMPRESA sin reparto (11-sep-2026: OTRO, NOMINA,
      //    GASOLINA, FIJO, VISITA) tampoco, ni con avión sellado ni con
      //    vuelo: son de VuelaTour (ver la rama explícita abajo).
      // Con reparto manual los PARCIALES mandan (aeronave_id del gasto se
      // ignora — regla binaria); cada parcial convierte con la MISMA regla
      // del padre (moneda + tc_gasto): sin TC no se acredita (ya está en el
      // aviso del libro).
      const acreditar = (aid: string, monto_: number, parcial: boolean) => {
        const destino =
          g.categoria === 'PERMISO'
            ? permisosPorAvion
            : parcial && g.categoria !== 'INDIRECTO' && g.categoria !== 'NOMINA'
              ? otrosPorAvion
              : indirectosPorAvion;
        destino.set(aid, (destino.get(aid) ?? 0) + monto_);
      };
      if (esTuas) {
        // Regla 7: nunca se acredita a un avión (ver arriba).
      } else if (pagoAfac) {
        // Invariante 90: lo paga VuelaTour — fuera de `permisosPorAvion`
        // (espejo de la hoja «permisos» del balance y del grupo PERMISO del
        // reparto). Sigue en el acumulado de «otros gastos» (es caja).
      } else if (filasReparto && filasReparto.length > 0) {
        for (const r of filasReparto) {
          const mxnParcial =
            g.moneda === 'MXN' ? r.monto : tcg != null ? r.monto * tcg : null;
          if (mxnParcial != null) acreditar(r.aeronave_id, mxnParcial, true);
        }
      } else if (categoriaFueraDelAvion(g.categoria as string | null)) {
        // Las DOS del pago al vendedor (28-sep y 13-oct-2026) tampoco se
        // acreditan a un avión por este eje genérico (defensa: siempre traen
        // vuelo y no son de empresa, así que no llegan a esta lectura). LA CATEGORÍA DE EMPRESA MANDA (11-sep-2026): OTRO/NOMINA/GASOLINA/
        // FIJO/VISITA son de VuelaTour aunque traigan avión SELLADO o vuelo
        // — no se acreditan a ningún avión en utilidades (antes un NOMINA
        // sellado a una matrícula caía en sus "gastos indirectos" mientras
        // el Balance por avión ya lo había sacado de ahí). Sin reparto
        // manual, el gasto entero se queda en el acumulado de la empresa.
      } else {
        const aid = g.aeronave_id as string | null;
        if (aid && mxn != null) acreditar(aid, mxn, false);
      }
    }

    // ===== Pestaña COMBUSTIBLE (26-ago-2026): el gas del mes por avión =====
    // Con o sin vuelo, eje fecha_gasto — mismo eje que el reparto. Avión de
    // la carga (Regla B, avionDelGasto): avión del TRAMO ligado (con
    // herencia) → avión sellado → avión del vuelo; sin vuelo, aeronave_id.
    // Las cargas SIN avión se listan (el dinero jamás desaparece) marcadas
    // para asignarles aeronave.
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
      const gVueloId = (g.vuelo_id as string | null) ?? null;
      const aid: string | null = gVueloId
        ? avionDelGasto(
            {
              escala_id: (g.escala_id as string | null) ?? null,
              aeronave_id: (g.aeronave_id as string | null) ?? null,
            },
            escalaPorId,
            vueloAvion.get(gVueloId) ?? null,
          )
        : ((g.aeronave_id as string | null) ?? null);
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
    // + la columna OTROS INGRESOS del avión (13-oct-2026, invariante 67):
    // Σ remanente de sus ingresos asignados; la llave SOLO con dato y un
    // avión con solo ingresos entra con las otras 4 en null.
    const utilidadesAviones: DineroUtilidadAvionPayload[] = [];
    for (const [id, a] of aviones) {
      const ind = indirectosPorAvion.get(id);
      const otr = otrosPorAvion.get(id);
      const per = permisosPorAvion.get(id);
      const comb = combustiblePorAvion.get(id);
      const oi = otrosIngresosPorAvion.get(id);
      if (
        ind == null &&
        otr == null &&
        per == null &&
        comb == null &&
        oi == null
      ) {
        continue;
      }
      utilidadesAviones.push({
        matricula: a.matricula,
        gastos_indirectos_mxn: r2(ind ?? null),
        otros_gastos_mxn: r2(otr ?? null),
        permisos_mxn: r2(per ?? null),
        combustible_mxn: r2(comb ?? null),
        ...(oi != null ? { otros_ingresos_mxn: r2(oi) } : {}),
      });
    }
    // Solo INGRESOS (las filas de solo-egreso — TUA pagado sin línea TUAS —
    // llevan ingreso null y no entran): es lo que resta/suma en utilidades.
    // NETO del pago al vendedor (invariante 31): lo PAGADO de verdad (las DOS
    // categorías, apareados o de solo-egreso), que no es gasto de otra hoja
    // (ninguna entra a "otros gastos"): sin descontarlo aquí la utilidad
    // contaría la comisión cobrada como ingreso puro. Desde el 13-oct-2026
    // (API 0.0.74, invariante 61) ya NO se resta ninguna provisión: sin pago
    // real no se resta nada (exacto ⇒ ingreso − pagado = 0; parcial ⇒ +el
    // faltante; excedido ⇒ −el excedente). La «(avión)» también resta aquí
    // (caja de VuelaTour): la diferencia con el Balance general es la Σ de
    // las «(avión)» que carga un avión (`comisionAvionMxn`, informativa).
    const totalOtrosIngresos = otrosIngresos.reduce(
      (s, f) => s + (f.ingreso_mxn ?? 0),
      0,
    );
    const otrosIngresosNetos = r2n(
      totalOtrosIngresos - comisionPagadaMxn - comisionIngresosMxn,
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
      // ADITIVA (13-oct-2026, API 0.0.75, invariante 67), SOLO con filas:
      // los ingresos asignados a un avión, aparte y fuera de TOTALES.
      ...(otrosIngresosAvion.length
        ? { otros_ingresos_avion: otrosIngresosAvion }
        : {}),
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
      utilidades_otros_ingresos_mxn: otrosIngresosNetos,
      // Provisión del pago al vendedor (informativo): SIEMPRE 0 desde el
      // 0.0.74 (invariante 61: ya no hay provisión en ningún libro). La
      // clave se conserva por compat de forma — retirar en un lote futuro.
      utilidades_comision_vendedor_provisionada_mxn: 0,
      // Pagado DE VERDAD al vendedor (invariante 31; las DOS categorías desde
      // el 13-oct-2026, invariante 61), también descontado arriba. Clave que
      // viaja SOLO si algún vuelo tuvo pago real: sin pagos reales el
      // payload es byte-idéntico y pyservices no cambia sus leyendas.
      ...(hayPagoVendedorReal
        ? {
            utilidades_comision_vendedor_pagada_mxn: r2n(comisionPagadaMxn),
          }
        : {}),
      // ADITIVA (13-oct-2026, API 0.0.74, invariante 61), SOLO informativa:
      // de lo pagado, la Σ MXN de los pagos «Comisión del vendedor (avión)»
      // de vuelos que carga un avión — ya dentro de la de arriba (este libro
      // la resta porque el dinero salió de VuelaTour); es la diferencia
      // ESPERADA con el bloque VUELATOUR del Balance general. Viaja SOLO si
      // es > 0.
      ...(r2n(comisionAvionMxn) > 0
        ? {
            utilidades_comision_vendedor_avion_mxn: r2n(comisionAvionMxn),
          }
        : {}),
      utilidades_otros_gastos_mxn: r2(acumulado),
      utilidades_tc: nTc > 0 ? round6(sumaTc / nTc) : null,
      utilidades_aviones: utilidadesAviones,
      // ADITIVA (13-oct-2026, API 0.0.74, invariante 61): sin gasto real la
      // fila de comisión no lleva egreso y utilidades solo resta lo pagado.
      // pyservices cambia con ella solo leyendas. Viaja SIEMPRE.
      comision_vendedor_solo_gasto_real: true as const,
      // CIERRE DE MES (16-oct-2026, API 0.0.88, invariante 89; ADITIVO al
      // final, solo con la migración): mismo shape que el de los balances.
      ...(cierreDinero ? { cierre: cierreDinero.bloque } : {}),
    };
  }

  /**
   * CIERRE DE MES del Libro Dinero (invariante 89): marcas por vuelo
   * («Viene de septiembre 2026» / «Pendiente de cobro: pasará a … al
   * cerrar»), los vuelos que VIENEN (sin horas), y el bloque `cierre` con
   * los que PASAN (voló aquí, su dinero se fue: lectura aparte por
   * `fecha_vuelo`), VIENEN y PASARÍAN (mes abierto). Cifras de los
   * diferidos = bitácora del cierre (al corte).
   */
  private async cierreLibroDinero(ctx: {
    desde: string;
    hasta: string;
    vuelos: Array<Record<string, unknown>>;
    cobrosPorVuelo: Map<string, Array<Record<string, unknown>>>;
    clientes: Map<string, string>;
    aviones: Map<string, { matricula: string }>;
    claveDe: (v: Record<string, unknown>) => string;
  }): Promise<{
    marcas: Map<
      string,
      {
        cierre_marca: string;
        diferido_de: string | null;
        diferido_a: string | null;
      }
    >;
    venidos: Set<string>;
    bloque: BalanceCierrePayload;
  }> {
    const sb = this.supabase.service;
    const mes = mesCalendarioDeRango(ctx.desde, ctx.hasta);
    const fila = mes
      ? ((await leerCierresMes(sb)).find((f) => f.periodo === mes) ?? null)
      : null;
    // CIERRE POR AVIÓN (23-oct-2026, invariante 105): el Libro Dinero es de
    // toda la caja ⇒ estado de la FLOTA (puede ser PARCIAL) + «N de M».
    const flota = mes ? await resumenCierreFlota(sb, mes, fila) : null;
    const estado: EstadoMesFlota = flota
      ? flota.estado
      : (fila?.estado ?? 'ABIERTO');
    type V = {
      id: string;
      fecha_vuelo?: string | null;
      periodo_contable?: string | null;
      fecha_contable?: string | null;
    };
    const comoV = (v: Record<string, unknown>) => v as unknown as V;
    const venidosLista = ctx.vuelos.filter(
      (v) => papelContableEnPeriodo(comoV(v), ctx.desde, ctx.hasta) === 'viene',
    );
    // Sombras: voló en el periodo, su dinero se fue a otro mes.
    const { data: sombrasData, error: sErr } = await sb
      .from('vuelo')
      .select(`${DINERO_VUELO_COLS}${colsVueloContable(true)}`)
      .not('periodo_contable', 'is', null)
      // eje REAL a propósito (invariante 89): SOMBRAS: los que volaron aquí y se difirieron (lista `cierre.pasan`)
      .gte('fecha_vuelo', `${ctx.desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${ctx.hasta}T23:59:59-05:00`);
    if (sErr) throw new Error(sErr.message);
    const enLibro = new Set(ctx.vuelos.map((v) => v.id as string));
    const sombras = (
      (sombrasData ?? []) as unknown as Array<Record<string, unknown>>
    )
      .filter((v) => !enLibro.has(v.id as string))
      .filter(
        (v) =>
          papelContableEnPeriodo(comoV(v), ctx.desde, ctx.hasta) === 'sombra',
      );
    const bitacora = await leerDiferimientos(sb, [
      ...venidosLista.map((v) => v.id as string),
      ...sombras.map((v) => v.id as string),
    ]);
    const k = (v: Record<string, unknown>): number | null => {
      const t = Number(v.tc_usd_mxn);
      return Number.isFinite(t) && t > 0 ? t : null;
    };
    const mxn = (usd: number | null, v: Record<string, unknown>) => {
      const t = k(v);
      return usd != null && t != null ? Math.round(usd * t * 100) / 100 : null;
    };
    const item = (
      v: Record<string, unknown>,
      m: {
        venta_usd: number;
        cobrado_usd: number | null;
        por_cobrar_usd: number | null;
      },
      extra: {
        destino?: string;
        origen?: string;
        leyenda: string;
        /** ADITIVOS (16-oct-2026): ver `BalanceCierreVueloPayload`. */
        motivo?: MotivoDiferir;
        cobrado_despues_usd?: number | null;
        fecha_cobro_despues?: string | null;
      },
    ): BalanceCierreVueloPayload => ({
      clave: ctx.claveDe(v),
      vuelo_id: v.id as string,
      folio:
        typeof v.folio === 'number' || typeof v.folio === 'string'
          ? String(v.folio)
          : '',
      cliente: ctx.clientes.get(v.cliente_id as string) ?? null,
      matricula: v.aeronave_id
        ? (ctx.aviones.get(v.aeronave_id as string)?.matricula ?? null)
        : v.es_externo === true
          ? 'EXTERNO'
          : null,
      fecha: (v.fecha_vuelo as string | null) ?? null,
      venta_mxn: mxn(m.venta_usd, v),
      venta_usd: m.venta_usd,
      cobrado_mxn: mxn(m.cobrado_usd, v),
      cobrado_usd: m.cobrado_usd,
      por_cobrar_mxn: mxn(m.por_cobrar_usd, v),
      por_cobrar_usd: m.por_cobrar_usd,
      ...(extra.destino ? { destino: extra.destino } : {}),
      ...(extra.origen ? { origen: extra.origen } : {}),
      leyenda: extra.leyenda,
      ...(extra.motivo
        ? {
            motivo: extra.motivo,
            ...(extra.destino ? { corte: corteDeDestino(extra.destino) } : {}),
            ...(extra.cobrado_despues_usd !== undefined
              ? {
                  cobrado_despues_usd: extra.cobrado_despues_usd,
                  cobrado_despues_mxn: mxn(extra.cobrado_despues_usd, v),
                  fecha_cobro_despues: extra.fecha_cobro_despues ?? null,
                }
              : {}),
          }
        : {}),
    });
    const marcas = new Map<
      string,
      {
        cierre_marca: string;
        diferido_de: string | null;
        diferido_a: string | null;
      }
    >();
    const pasan: BalanceCierreVueloPayload[] = [];
    for (const v of sombras) {
      const vv = comoV(v);
      const real = mesRealDeVuelo(vv);
      const sal = real ? salidaDeVuelo(vv.id, real, bitacora) : null;
      const destino = sal?.destino ?? mesContableDeVuelo(vv) ?? '';
      const montos = sal ?? {
        venta_usd: Number(v.monto_total_usd) || 0,
        cobrado_usd: 0,
        por_cobrar_usd: Number(v.monto_total_usd) || 0,
      };
      pasan.push(
        item(v, montos, {
          destino,
          leyenda: destino ? leyendaPasaA(destino, montos) : 'Pasa a otro mes',
          ...(sal?.motivo ? { motivo: sal.motivo } : {}),
        }),
      );
    }
    const vienen: BalanceCierreVueloPayload[] = [];
    const venidos = new Set<string>();
    for (const v of venidosLista) {
      const vv = comoV(v);
      const contableMes = mesContableDeVuelo(vv);
      const origen =
        (contableMes ? origenDeVuelo(vv, contableMes, bitacora) : null) ??
        mesRealDeVuelo(vv) ??
        '';
      const b = bitacora.find(
        (x) => x.vuelo_id === vv.id && x.destino === contableMes,
      );
      const leyenda = leyendaVieneDe(origen);
      vienen.push(
        item(
          v,
          {
            venta_usd: b?.venta_usd ?? (Number(v.monto_total_usd) || 0),
            cobrado_usd: b?.cobrado_usd ?? null,
            por_cobrar_usd: b?.por_cobrar_usd ?? null,
          },
          { origen, leyenda },
        ),
      );
      venidos.add(vv.id);
      marcas.set(vv.id, {
        cierre_marca: leyenda,
        diferido_de: origen,
        diferido_a: null,
      });
    }
    const pasarian: BalanceCierreVueloPayload[] = [];
    if (mes && estado !== 'CERRADO') {
      const destino = mesSiguienteDe(mes);
      const ultimo = rangoDelMes(mes).hasta;
      const completados = ctx.vuelos.filter(
        (v) => v.estado === 'COMPLETADO' && !venidos.has(v.id as string),
      );
      const internos = new Set<string>();
      const ids = [
        ...new Set(
          completados
            .map((v) => v.cliente_id as string | null)
            .filter((x): x is string => !!x),
        ),
      ];
      if (ids.length > 0) {
        const { data, error } = await sb
          .from('cliente')
          .select('id')
          .in('id', ids)
          .eq('es_interno', true);
        if (error) throw new Error(error.message);
        for (const c of data ?? []) internos.add(c.id as string);
      }
      for (const v of completados) {
        // Un avión cerrado ya decidió que se queda (regla 2, inv. 105).
        if (flota?.decididos.has(v.id as string)) continue;
        const d = decisionDiferir(
          {
            estado: 'COMPLETADO',
            monto_total_usd: v.monto_total_usd as string | number | null,
            tc_usd_mxn: k(v),
            k_cotizacion: k(v),
            cliente_interno: internos.has(v.cliente_id as string),
          },
          ctx.cobrosPorVuelo.get(v.id as string) ?? [],
          ultimo,
        );
        if (!d) continue;
        pasarian.push(
          item(v, d, {
            destino,
            leyenda: leyendaPasara(destino, d),
            motivo: d.motivo,
            cobrado_despues_usd: d.cobrado_posterior_usd,
            fecha_cobro_despues: d.fecha_cobro_posterior,
          }),
        );
        marcas.set(v.id as string, {
          cierre_marca: marcaPasaraAlCerrar(destino, d),
          diferido_de: null,
          diferido_a: destino,
        });
      }
    }
    const porFolio = (
      a: BalanceCierreVueloPayload,
      b: BalanceCierreVueloPayload,
    ) => (Number(a.folio) || 0) - (Number(b.folio) || 0);
    return {
      marcas,
      venidos,
      bloque: {
        disponible: true,
        periodo: mes,
        estado,
        cerrado_at: fila?.cerrado_at ?? null,
        cerrado_por_nombre: fila?.cerrado_por?.nombre ?? null,
        reabierto_at: fila?.reabierto_at ?? null,
        reabierto_por_nombre: fila?.reabierto_por?.nombre ?? null,
        pasan: pasan.sort(porFolio),
        vienen: vienen.sort(porFolio),
        pasarian: pasarian.sort(porFolio),
        ...(flota
          ? {
              estado_flota: flota.estado,
              aviones_activos: flota.aviones_activos,
              aviones_cerrados: flota.aviones_cerrados,
            }
          : {}),
      },
    };
  }
}
