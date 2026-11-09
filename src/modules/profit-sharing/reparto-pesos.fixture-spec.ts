/**
 * MUNDO DEL REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92).
 *
 * El mundo de los libros (`libros-pago-vendedor.fixture-spec`: vuelo #501 de
 * XB-TST con K 20, cobro MXN 20,000 con comisión bancaria de 350 y cobro USD
 * 1,000) más lo que el reparto en pesos tiene que recorrer:
 *  - #502 (XB-TST) SIN T.C. en la cotización y cobrado en DÓLARES (sus cobros
 *    no piden T.C.) con una comisión bancaria de 30 USD: sus pesos (venta y
 *    comisión) salen del oficial del día de la COTIZACIÓN (14-sep), el MISMO
 *    K del balance — sin mover un dólar.
 *  - gastos en dólares con `tc_gasto` (OPERACIONES 200 a 19.5) y SIN él
 *    (REFACCION 100 del 20-sep ⇒ oficial de su día), un PERMISO MXN con
 *    T.C. propio y el GAS MXN sin T.C. del mundo base (sin oficial no llega a
 *    dólares, pero sus pesos SÍ cuentan).
 *  - FIJOS del pool (MXN con T.C. propio y USD sin él) prorrateados entre los
 *    dos aviones activos.
 *  - reserva de overhaul (40 USD/hr) a pesos con el oficial del cierre.
 *  - el ingreso ING-14 (MXN 46,550.80) asignado al XB-TST.
 *  - socios 40.92 / 59.08 (el residuo en centavos cae en uno) y el XB-DOS
 *    SIN vuelos con un socio al 100 %.
 *
 * Los oficiales por DÍA (`TC_OFICIAL_PESOS`) son distintos a propósito: cada
 * conversión dice de qué día salió su T.C.
 *
 * `*-spec.ts` (sin punto) ⇒ fuera del build y de jest.
 */
import {
  AV,
  DIA,
  V1,
  fakeSupabase,
  gastoBase,
  mundoLibros,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';

/**
 * El mini-PostgREST de los libros + el CONTEO de aviones activos
 * (`select('id', { count: 'exact', head: true })`) que el reparto usa para
 * prorratear el pool de FIJOS (el de los libros no sabe contar: con él el
 * pool nunca se repartía).
 */
export function fakeSupabaseReparto(
  tablas: Record<string, Fila[]>,
  opts: { sinMigracion?: boolean } = {},
) {
  const f = fakeSupabase(tablas, opts);
  const fromBase = f.supabase.service.from;
  const from = (tabla: string) => {
    const q = fromBase(tabla);
    if (tabla !== 'aeronave') return q;
    const selectBase = q.select as (cols?: string) => unknown;
    q.select = (cols?: string, o?: { count?: string }) => {
      if (!o?.count) return selectBase(cols);
      const activos = (tablas.aeronave ?? []).filter(
        (a) => a.activa === true,
      ).length;
      const r: Record<string, unknown> = {
        eq: () => r,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ count: activos, data: null, error: null }).then(
            res,
            rej,
          ),
      };
      return r;
    };
    return q;
  };
  return { ...f, supabase: { service: { from } } };
}

export const AV2 = 'av-2';
export const V3 = 'v-3';
export const HERNAN = 'u-hernan';
export const ACC = 'u-acc';
export const MAU = 'u-mau';

/** Oficial por día (los que no están: sin dato). */
export const TC_OFICIAL_PESOS: Record<string, number> = {
  // ING-14 (fecha del ingreso).
  '2026-09-04': 18,
  // Día del GAS, del OPERACIONES y del FIJO USD (DIA).
  '2026-09-10': 17.9,
  // Cotización del #502 (sin T.C. capturado).
  '2026-09-14': 18.25,
  // REFACCION USD sin tc_gasto.
  '2026-09-20': 18.4,
  // Cierre del periodo (reserva de overhaul).
  '2026-09-30': 18.6,
};

export const ING_PESOS: Fila = {
  id: 'i-av',
  folio: 14,
  categoria: 'REEMBOLSO_DEVOLUCION',
  fecha: '2026-09-04',
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  monto: 46550.8,
  comision_monto: null,
  moneda: 'MXN',
  tc_usd_mxn: null,
  pagador: 'angel alvarez',
  aeronave_id: AV,
  aeronave: { matricula: 'XB-TST', color_calendario: '#3B82F6' },
  cuenta: { alias: 'EJE SCOTIA', banco: 'Scotiabank' },
  notas: null,
  deleted_at: null,
  cliente: null,
  vuelo: null,
};

/** #502: sin T.C. en la cotización, cobrado en dólares (1,000 de 1,500). */
function vuelo502(base: Fila): Fila {
  return {
    ...base,
    id: V3,
    folio: 502,
    fecha_vuelo: '2026-09-15T15:00:00+00:00',
    fecha_solicitud: '2026-09-14T15:00:00+00:00',
    origen_iata: 'CUN',
    destino_iata: 'CZM',
    tiempo_cobrable_hr: 1.5,
    subtotal_vuelo_usd: 1500,
    tuas_usd: 0,
    extras_total_usd: 0,
    comision_vendedor_usd: 0,
    comision_vendedor_nombre: null,
    monto_total_usd: 1500,
    monto_total_mxn: null,
    tc_usd_mxn: null,
    cobrado: false,
  };
}

/**
 * El mundo del reparto en pesos. `ingresos` = los ingresos de resultado
 * (por default ING-14 al XB-TST); `sinVuelo502` quita el #502.
 */
export function mundoPesos(
  opts: { ingresos?: Fila[]; sinVuelo502?: boolean } = {},
): Record<string, Fila[]> {
  const m = mundoLibros(opts.ingresos ?? [ING_PESOS]);
  const v501 = m.vuelo[0];
  const vuelos = opts.sinVuelo502 ? [v501] : [v501, vuelo502(v501)];
  return {
    ...m,
    aeronave: [
      ...m.aeronave.map((a) => ({ ...a, activa: true })),
      { ...m.aeronave[0], id: AV2, matricula: 'XB-DOS', activa: true },
    ],
    vuelo: vuelos,
    escala: [
      ...m.escala,
      ...(opts.sinVuelo502
        ? []
        : [
            {
              ...m.escala[0],
              id: 'e-3',
              vuelo_id: V3,
              taco_salida: 200,
              taco_llegada: 201.5,
              destino_iata: 'CZM',
              fecha_salida_plan: '2026-09-15T15:00:00+00:00',
              vuelo: {
                fecha_vuelo: '2026-09-15T15:00:00+00:00',
                aeronave_id: AV,
              },
            },
          ]),
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      ...(opts.sinVuelo502
        ? []
        : [
            {
              id: 'c-3',
              vuelo_id: V3,
              monto: 1000,
              moneda: 'USD',
              tc_usd_mxn: null,
              fecha_cobro: '2026-09-15T18:00:00+00:00',
              // Comisión bancaria en DÓLARES de un vuelo sin K para los
              // dólares: sus pesos salen con el K del balance (18.25).
              comision_banco_monto: 30,
            },
          ]),
    ],
    gasto: [
      ...m.gasto,
      {
        ...gastoBase,
        id: 'g-op-usd',
        vuelo_id: V1,
        aeronave_id: AV,
        vuelo: { folio: 501, aeronave_id: AV },
        categoria: 'OPERACIONES',
        moneda: 'USD',
        monto: 200,
        tc_gasto: 19.5,
      },
      {
        ...gastoBase,
        id: 'g-ref-usd',
        aeronave_id: AV,
        categoria: 'REFACCION',
        moneda: 'USD',
        monto: 100,
        fecha_gasto: '2026-09-20',
      },
      {
        ...gastoBase,
        id: 'g-permiso',
        aeronave_id: AV,
        categoria: 'PERMISO',
        monto: 500,
        tc_gasto: 18,
      },
      {
        ...gastoBase,
        id: 'g-fijo',
        categoria: 'FIJO',
        monto: 7000,
        tc_gasto: 17.5,
      },
      {
        ...gastoBase,
        id: 'g-fijo-usd',
        categoria: 'FIJO',
        moneda: 'USD',
        monto: 300,
        fecha_gasto: DIA,
      },
    ],
    reserva_overhaul: [
      {
        aeronave_id: AV,
        monto_por_hora_usd: '40',
        horas_acumuladas: '0',
      },
    ],
    aeronave_socio: [
      {
        aeronave_id: AV,
        socio_id: HERNAN,
        porcentaje: '40.920',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
        usuario: { nombre: 'Hernán Pérez', es_empresa: false },
      },
      {
        aeronave_id: AV,
        socio_id: ACC,
        porcentaje: '59.080',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
        usuario: {
          nombre: 'Aero Charter Cancun S.A. de C.V.',
          es_empresa: true,
        },
      },
      {
        aeronave_id: AV2,
        socio_id: MAU,
        porcentaje: '100.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
        usuario: { nombre: 'Mauricio Roque', es_empresa: false },
      },
    ],
    usuario: [
      { id: HERNAN, nombre: 'Hernán Pérez' },
      { id: ACC, nombre: 'Aero Charter Cancun S.A. de C.V.' },
      { id: MAU, nombre: 'Mauricio Roque' },
    ],
  };
}

/**
 * Las llaves NUEVAS del reparto en pesos (contrato §2a): lo único que el
 * 0.0.94 agrega a `GET /v1/profit-sharing`. Quitarlas debe dejar la
 * respuesta BYTE A BYTE como la del 0.0.93 (golden).
 */
export function sinLlavesPesos(r: unknown): unknown {
  const c = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
  delete c.reparto_en_pesos;
  for (const a of (c.aviones as Array<Record<string, unknown>>) ?? []) {
    const ing = a.ingresos as Record<string, unknown>;
    for (const k of [
      'cobrado_mxn',
      'comisiones_venta_mxn',
      'pendiente_cobro_mxn',
      'otros_ingresos_avion_mxn',
    ])
      delete ing[k];
    const gas = a.gastos as Record<string, unknown>;
    for (const k of [
      'directos_mxn',
      // COMBUSTIBLE (23-oct-2026, invariante 104): también en pesos.
      'combustible_mxn',
      'indirectos_mxn',
      'permisos_mxn',
      'otros_prorrateados_mxn',
    ])
      delete gas[k];
    delete a.reserva_overhaul_mxn;
    delete a.saldo_disponible_mxn;
    delete a.utilidad_antes_gastos_mxn;
    delete a.pesos_sin_tc_usd;
    // Cascada del balance (20-oct-2026, invariante 99): sus pesos también.
    delete a.afac_reservado_mxn;
    delete a.reserva_retenida_mxn;
    for (const s of a.reparto as Array<Record<string, unknown>>) {
      delete s.monto_mxn;
      delete s.utilidad_mxn;
      delete s.reserva_mxn;
    }
    const det = a.detalle as Record<string, unknown>;
    for (const v of det.vuelos as Array<Record<string, unknown>>) {
      delete v.cobrado_avion_mxn;
      delete v.pendiente_avion_mxn;
      delete v.tc_pesos;
      delete v.afac_reservado_avion_mxn;
    }
    for (const g of det.gastos_por_categoria as Array<Record<string, unknown>>)
      delete g.mxn;
    const res = det.reserva as Record<string, unknown>;
    delete res.monto_mxn;
    delete res.tc;
    const afac = det.afac as Record<string, unknown> | undefined;
    if (afac) delete afac.monto_mxn;
    for (const o of det.otros_ingresos_avion as Array<Record<string, unknown>>)
      delete o.mxn;
  }
  return c;
}

/** Lo mismo para el payload del PDF/XLSX (contrato §2b). */
export function sinLlavesPesosPayload(p: unknown): unknown {
  const c = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  delete c.reparto_en_pesos;
  delete c.generado;
  for (const a of (c.aviones as Array<Record<string, unknown>>) ?? []) {
    for (const k of [
      'ingresos_cobrado_mxn',
      'comisiones_venta_mxn',
      'pendiente_cobro_mxn',
      'gastos_directos_mxn',
      'gastos_indirectos_mxn',
      'permisos_mxn',
      'otros_mxn',
      'reserva_overhaul_mxn',
      'otros_ingresos_avion_mxn',
      'saldo_mxn',
      'pesos_sin_tc_usd',
      'reserva_tc',
      // Cascada del balance (20-oct-2026, invariante 99): sus pesos también.
      'afac_reservado_mxn',
      'reserva_retenida_mxn',
      // Combustible aparte (23-oct-2026, invariante 104): sus pesos también.
      'combustible_mxn',
      'utilidad_antes_gastos_mxn',
    ])
      delete a[k];
    for (const s of a.reparto as Array<Record<string, unknown>>) {
      delete s.monto_mxn;
      delete s.utilidad_mxn;
      delete s.reserva_mxn;
    }
    for (const v of a.vuelos as Array<Record<string, unknown>>) {
      delete v.cobrado_mxn;
      delete v.pendiente_mxn;
      // CLAVES SIN APODO (23-oct-2026, invariante 106): el consecutivo y la
      // ruta de cada línea de vuelo son aditivos (el golden es anterior).
      delete v.consecutivo_cliente;
      delete v.ruta;
    }
    for (const o of a.otros_ingresos_avion as Array<Record<string, unknown>>)
      delete o.mxn;
  }
  return c;
}
