// La cadena real de FlightsService arrastra googleapis y `jose` (ESM): se
// stubbea (solo la necesita IngresosService en la prueba de paridad).
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import {
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import { IngresosService } from '../ingresos/ingresos.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import type { FlightsService } from '../flights/flights.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import type {
  ConciliacionDeEntradaRespuesta,
  OrigenEntrada,
} from './abonos-de-entrada.util';
import type { UltimoMovimientoCuenta } from './cargos-de-gasto.util';
import {
  C,
  CTA,
  EC,
  esSonda,
  fakeEntradas,
  ING,
  K,
  M,
  mundoProd,
  SIN_INGRESOS,
  SIN_PUENTE,
  U,
  VUELO,
  type ConsultaFake,
  type OpcionesFakeEntradas,
  type Row,
  type Tablas,
} from './conciliacion-entradas.fixture-spec';

/**
 * CONCILIACIÓN AL REVÉS DE ENTRADAS (14-oct-2026, API 0.0.78, invariante
 * 78): `conciliacionDeEntrada('COBRO_VUELO' | 'INGRESO', id)` sobre las FILAS
 * REALES de prod (ING-3, #293, el SPEI de $69,183.00 de #315 + #332, el lote
 * de $55,053.00, #223 de Morena Mia, #379 de Palma, #383 de This Is Czm) y
 * sintéticos rotulados (parcial de Beh Kay, sobre, anticipo, liga vieja con
 * sobrante). Casos a)–x) de la spec + la paridad lista ↔ hoja.
 */

function armar(db: Tablas, opts: OpcionesFakeEntradas = {}) {
  const f = fakeEntradas(db, opts);
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, ...f };
}

const cobro = (svc: ConciliacionService, id: string) =>
  svc.conciliacionDeEntrada('COBRO_VUELO', id);
const ingreso = (svc: ConciliacionService, id: string) =>
  svc.conciliacionDeEntrada('INGRESO', id);

const respuestaDe = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!e) throw new Error('se esperaba un error');
  const r = (e as { getResponse?: () => unknown }).getResponse?.() as
    | { error?: string; message?: string }
    | undefined;
  return { e, code: r?.error, message: r?.message };
};

/** Cuentas SIN número ni CLABE (como viajan). */
const cuenta = (
  id: string,
  alias: string,
  banco: string,
  moneda: string,
  tipo: string,
) => ({
  id,
  alias,
  banco,
  moneda,
  tipo,
});
const COMBUSTIBLE = cuenta(
  CTA.COMBUSTIBLE,
  'COMBUSTIBLE',
  'Scotiabank',
  'MXN',
  'BANCO',
);
const EJE = cuenta(CTA.EJE_SCOTIA, 'EJE SCOTIA', 'Scotiabank', 'MXN', 'BANCO');
const PAYWISE = cuenta(CTA.PAYWISE, 'Paywise', 'Paywise', 'MXN', 'PASARELA');

/** «¿Qué hay importado?» del ejemplo D de la spec (orden del cotejo: por alias). */
const ULTIMOS_PROD: UltimoMovimientoCuenta[] = [
  {
    cuenta: cuenta(CTA.AFIRME, 'afirme', 'afirme', 'MXN', 'BANCO'),
    primera_fecha: null,
    ultima_fecha: null,
  },
  {
    cuenta: cuenta(
      CTA.AMEX_ALE,
      'American Express Ale',
      'American Express',
      'MXN',
      'BANCO',
    ),
    primera_fecha: null,
    ultima_fecha: null,
  },
  {
    cuenta: COMBUSTIBLE,
    primera_fecha: '2026-07-01',
    ultima_fecha: '2026-10-12',
  },
  { cuenta: EJE, primera_fecha: '2026-09-01', ultima_fecha: '2026-10-12' },
  {
    cuenta: cuenta(
      CTA.GASTOS_GNRAL,
      'GASTOS GNRAL',
      'Scotiabank',
      'MXN',
      'BANCO',
    ),
    primera_fecha: '2026-07-01',
    ultima_fecha: '2026-10-12',
  },
  {
    cuenta: cuenta(CTA.HSBC_PESOS, 'HSBC Pesos', 'HSBC', 'MXN', 'BANCO'),
    primera_fecha: '2026-09-01',
    ultima_fecha: '2026-10-07',
  },
  {
    cuenta: cuenta(CTA.HSBC_USD, 'HSBC USD', 'HSBC', 'USD', 'BANCO'),
    primera_fecha: '2026-09-01',
    ultima_fecha: '2026-10-06',
  },
  { cuenta: PAYWISE, primera_fecha: '2026-09-01', ultima_fecha: '2026-09-30' },
  {
    cuenta: cuenta(
      CTA.TARJETA_CREDITO_HSBC,
      'Tarjeta credito personal HSBC',
      'HSBC',
      'MXN',
      'BANCO',
    ),
    primera_fecha: null,
    ultima_fecha: null,
  },
];
const porAlias = <T extends { cuenta: { alias: string } }>(
  l: T[] | null,
): T[] | null =>
  l
    ? [...l].sort((a, b) => a.cuenta.alias.localeCompare(b.cuenta.alias, 'es'))
    : null;

/** Las consultas que NO son sondas de columna. */
const deNegocio = (log: ConsultaFake[]) => log.filter((c) => !esSonda(c));

// ------------------------------------------------- sintéticos (rotulados)

/** SINTÉTICO (0.0.78, incidente Beh Kay): $3,400.00 pagado en dos SPEI de $1,700.00. */
const BEH_3400 = 'c0000000-0000-4000-8000-000000003400';
const SPEI_1 = 'a0000000-0000-4000-8000-000000000001';
const SPEI_2 = 'a0000000-0000-4000-8000-000000000002';
function conParcial(db: Tablas, segundo: boolean): Tablas {
  db.cobro_vuelo.push({
    id: BEH_3400,
    vuelo_id: VUELO[315],
    monto: 3400,
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    comision_banco_monto: null,
    tc_usd_mxn: 17.15,
    fecha_cobro: '2026-09-20T17:00:00+00:00',
    referencia: 'camionetas',
    notas: null,
    cuenta_destino: 'Scotiabank Pesos',
    registrado_por: U.ITZI,
    created_at: '2026-09-21T15:00:00+00:00',
    cobro_grupo_id: null,
    ingreso_anticipo_id: null,
  });
  const spei = (id: string, fecha: string, cobroId: string | null): Row => ({
    id,
    cuenta_bancaria_id: CTA.EJE_SCOTIA,
    fecha,
    tipo: 'ABONO',
    monto: 1700,
    monto_bruto: null,
    comision_monto: null,
    descripcion: 'TRANSF INTERBANCARIA SPEI',
    referencia: null,
    conciliado: cobroId !== null,
    gasto_id: null,
    cobro_id: cobroId,
    cobro_grupo_id: null,
    clasificacion_id: null,
    ingreso_id: null,
    cobros_n: cobroId ? 1 : 0,
    orden_archivo: null,
    origen: 'IMPORTADO',
    notas: null,
    created_at: '2026-10-06T15:22:46.58996+00:00',
    created_by: U.ALEJANDRO,
    estado_cuenta_id: EC.SCOTIA_EJE_SEP,
  });
  db.movimiento_bancario.push(
    spei(SPEI_1, '2026-09-20', BEH_3400),
    spei(SPEI_2, '2026-09-21', segundo ? BEH_3400 : null),
  );
  db.movimiento_bancario_cobro.push({
    movimiento_id: SPEI_1,
    cobro_id: BEH_3400,
    monto_parte: 1700,
    created_at: '2026-10-13T17:00:00+00:00',
    created_by: U.ALEJANDRO,
  });
  if (segundo) {
    db.movimiento_bancario_cobro.push({
      movimiento_id: SPEI_2,
      cobro_id: BEH_3400,
      monto_parte: 1700,
      created_at: '2026-10-14T18:00:00+00:00',
      created_by: U.DIEGO,
    });
  }
  return db;
}

/** SINTÉTICO (0 sobres en prod): sobre de $10,800.76 en 3 aviones, ligado a un abono. */
const SOBRE = 's0000000-0000-4000-8000-000000000004';
const PARTE_SOBRE = 'c0000000-0000-4000-8000-000000000901';
const ABONO_SOBRE = 'a0000000-0000-4000-8000-000000000004';
function conSobre(db: Tablas, ligado = true): Tablas {
  db.vuelo_grupo.push({ id: 'g-boda', folio: 4, nombre: 'Boda Pérez' });
  db.cobro_grupo.push({
    id: SOBRE,
    grupo_id: 'g-boda',
    monto: 10800.76,
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    fecha_cobro: '2026-09-18T17:00:00+00:00',
    referencia: null,
    comision_banco_monto: null,
  });
  [3600.25, 3600.25, 3600.26].forEach((monto, i) => {
    db.vuelo.push({ id: `v-boda-${i}`, folio: 901 + i, cliente_id: K.PALMA });
    db.cobro_vuelo.push({
      id: i === 0 ? PARTE_SOBRE : `c0000000-0000-4000-8000-00000000090${i + 1}`,
      vuelo_id: `v-boda-${i}`,
      monto,
      moneda: 'MXN',
      metodo_cobro: 'TRANSFERENCIA',
      comision_banco_monto: null,
      tc_usd_mxn: 17.3,
      fecha_cobro: '2026-09-18T17:00:00+00:00',
      referencia: null,
      notas: null,
      cuenta_destino: 'Scotiabank Pesos',
      registrado_por: U.ITZI,
      created_at: '2026-09-18T18:00:00+00:00',
      cobro_grupo_id: SOBRE,
      ingreso_anticipo_id: null,
    });
  });
  db.movimiento_bancario.push({
    id: ABONO_SOBRE,
    cuenta_bancaria_id: CTA.EJE_SCOTIA,
    fecha: '2026-09-18',
    tipo: 'ABONO',
    monto: 10800.76,
    monto_bruto: null,
    comision_monto: null,
    descripcion: 'TRANSF INTERBANCARIA SPEI BODA',
    referencia: null,
    conciliado: ligado,
    gasto_id: null,
    cobro_id: null,
    cobro_grupo_id: ligado ? SOBRE : null,
    clasificacion_id: null,
    ingreso_id: null,
    cobros_n: 0,
    orden_archivo: null,
    origen: 'IMPORTADO',
    notas: null,
    created_at: '2026-10-06T15:22:46.58996+00:00',
    created_by: U.ALEJANDRO,
    estado_cuenta_id: EC.SCOTIA_EJE_SEP,
  });
  return db;
}

/** SINTÉTICO (0 anticipos en prod): $20,000.00 aplicado del anticipo ING-12 de $50,000.00. */
const ING12 = 'i0000000-0000-4000-8000-000000000012';
const COBRO_ANT = 'c0000000-0000-4000-8000-000000020000';
const ABONO_ANT = 'a0000000-0000-4000-8000-000000000012';
function conAnticipo(db: Tablas, conciliado = true): Tablas {
  db.ingreso.push({
    id: ING12,
    folio: 12,
    categoria: 'ANTICIPO_CLIENTE',
    fecha: '2026-09-01',
    descripcion: 'Anticipo temporada',
    monto: 50000,
    comision_monto: null,
    moneda: 'MXN',
    tc_usd_mxn: null,
    metodo: 'TRANSFERENCIA',
    cuenta_bancaria_id: CTA.EJE_SCOTIA,
    pagador: null,
    cliente_id: K.PALMA,
    vuelo_id: null,
    created_by: U.ALEJANDRO,
    created_at: '2026-09-01T16:00:00+00:00',
    updated_at: '2026-09-01T16:00:00+00:00',
    deleted_at: null,
  });
  db.cobro_vuelo.push({
    id: COBRO_ANT,
    vuelo_id: VUELO[380],
    monto: 20000,
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    comision_banco_monto: null,
    tc_usd_mxn: 18.19,
    fecha_cobro: '2026-09-05T17:00:00+00:00',
    referencia: null,
    notas: null,
    cuenta_destino: 'Scotiabank Pesos',
    registrado_por: U.ALEJANDRO,
    created_at: '2026-09-05T18:00:00+00:00',
    cobro_grupo_id: null,
    ingreso_anticipo_id: ING12,
  });
  if (conciliado) {
    db.movimiento_bancario.push({
      id: ABONO_ANT,
      cuenta_bancaria_id: CTA.EJE_SCOTIA,
      fecha: '2026-09-01',
      tipo: 'ABONO',
      monto: 50000,
      monto_bruto: null,
      comision_monto: null,
      descripcion: 'TRANSF INTERBANCARIA SPEI ANTICIPO',
      referencia: null,
      conciliado: true,
      gasto_id: null,
      cobro_id: null,
      cobro_grupo_id: null,
      clasificacion_id: null,
      ingreso_id: ING12,
      cobros_n: 0,
      orden_archivo: null,
      origen: 'IMPORTADO',
      notas: null,
      created_at: '2026-10-06T15:22:46.58996+00:00',
      created_by: U.ALEJANDRO,
      estado_cuenta_id: EC.SCOTIA_EJE_SEP,
    });
    db.ingreso_bitacora.push({
      id: 'b-12',
      ingreso_id: ING12,
      accion: 'CONCILIAR',
      actor_id: U.DIEGO,
      created_at: '2026-10-13T12:00:00+00:00',
      diff: { por: 'NETO', movimiento_id: ABONO_ANT },
    });
  }
  return db;
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('CONCILIACIÓN AL REVÉS DE ENTRADAS — conciliacionDeEntrada', () => {
  it('a) ING-3 «DLO DIDI RIDES MX (AJUSTE)» $78.00: 200 exacto al ejemplo A (llaves y orden)', async () => {
    const { svc } = armar(mundoProd());
    const r = await ingreso(svc, ING.ING3);
    expect(JSON.stringify(r)).toBe(
      JSON.stringify({
        entrada: {
          origen: 'INGRESO',
          id: ING.ING3,
          etiqueta: 'ING-3',
          categoria: 'OTRO_INGRESO',
          categoria_etiqueta: 'Otros ingresos',
          dia: '2026-09-10',
          monto: 78,
          comision: null,
          neto: 78,
          moneda: 'MXN',
          tc_usd_mxn: null,
          metodo: 'TRANSFERENCIA',
          metodo_etiqueta: 'Transferencia',
          cliente_nombre: 'didi',
          concepto: 'DLO DIDI RIDES MX (AJUSTE)',
          vuelo_id: null,
          vuelo_folio: null,
          cuenta: COMBUSTIBLE,
          cuenta_destino: null,
          registrado_por_nombre: 'Alejandro Canales',
          registrado_at: '2026-10-12T22:57:31.939317+00:00',
          es_reembolso: false,
          dado_de_baja: false,
        },
        estado: 'CONCILIADO',
        via: 'INGRESO',
        fuente: 'COLUMNA',
        cobertura: null,
        abonos: [
          {
            movimiento_id: M.DIDI_78,
            fecha: '2026-09-10',
            tipo: 'ABONO',
            monto: 78,
            moneda: 'MXN',
            descripcion: 'DLO DIDI RIDES MX (AJUSTE)',
            referencia: '00005579209156174929 REF. 9156174929 AUT. 085488',
            conciliado: true,
            origen: 'IMPORTADO',
            creado_at: '2026-09-29T20:35:24.413103+00:00',
            creado_por: 'Jimmy Chi',
            orden_archivo: null,
            cuenta: COMBUSTIBLE,
            estado_cuenta: {
              id: EC.SCOTIA_COMBUS_6,
              filename: 'scotia combus (6).pdf',
              formato: 'pdf',
              importado_at: '2026-09-29T20:35:24.229074+00:00',
              importado_por: 'Jimmy Chi',
              movimientos_importados: 75,
            },
            sin_archivo: null,
            monto_bruto: null,
            comision_pasarela: null,
            liga: {
              via: 'INGRESO',
              monto_parte: null,
              moneda: 'MXN',
              cruzada: false,
              tc_implicito: null,
              cuadre: { por: 'NETO', diferencia: 0, tolerancia: 1 },
              registro: {
                por: 'Alejandro Canales',
                at: '2026-10-12T22:57:32.606618+00:00',
              },
              sin_registro: null,
            },
            lote: null,
            notas_oficina: null,
          },
        ],
        sobre: null,
        anticipo: null,
        alertas: [],
        ultimos_movimientos: null,
        mismo_dia_cliente: null,
        cruce_no_corrio: null,
        varios_abonos_por_cobro: false,
      }),
    );
  });

  it('b) ingreso sin su CONCILIAR en la bitácora ⇒ SIN_BITACORA (jamás un nombre inventado)', async () => {
    const db = mundoProd();
    db.ingreso_bitacora = db.ingreso_bitacora.filter(
      (b) => b.ingreso_id !== ING.ING3,
    );
    const r = await ingreso(armar(db).svc, ING.ING3);
    expect(r.abonos[0].liga).toMatchObject({
      registro: null,
      sin_registro: 'SIN_BITACORA',
    });
  });

  it('c) la bitácora que falla ⇒ NO_LEIDO y 200', async () => {
    const r = await ingreso(
      armar(mundoProd(), { falla: (t) => t === 'ingreso_bitacora' }).svc,
      ING.ING3,
    );
    expect(r.estado).toBe('CONCILIADO');
    expect(r.abonos[0].liga).toMatchObject({
      registro: null,
      sin_registro: 'NO_LEIDO',
    });
  });

  it('d) #293 (Link de pago Paywise, comisión $624.76): 200 exacto al ejemplo B', async () => {
    const r = await cobro(armar(mundoProd()).svc, C.C293);
    expect(JSON.stringify(r)).toBe(
      JSON.stringify({
        entrada: {
          origen: 'COBRO_VUELO',
          id: C.C293,
          etiqueta: 'Vuelo #293',
          categoria: 'COBRO_VUELO',
          categoria_etiqueta: 'Cobro de vuelo',
          dia: '2026-09-11',
          monto: 12495,
          comision: 624.76,
          neto: 11870.24,
          moneda: 'MXN',
          tc_usd_mxn: 17,
          metodo: 'PAYWISE',
          metodo_etiqueta: 'Link de pago (Paywise)',
          cliente_nombre: 'Diego Beltra',
          concepto: null,
          vuelo_id: VUELO[293],
          vuelo_folio: 293,
          cuenta: null,
          cuenta_destino: 'Paywise',
          registrado_por_nombre: 'Itzi',
          registrado_at: '2026-09-21T16:43:40.081513+00:00',
          es_reembolso: false,
          dado_de_baja: false,
        },
        estado: 'CONCILIADO',
        via: 'DIRECTO',
        fuente: 'PUENTE',
        cobertura: {
          neto: 11870.24,
          monto_vinculado: 11870.24,
          faltante: 0,
          sobrante: 0,
          cubierto: true,
          abonos_n: 1,
          cruzado: false,
          tolerancia: 1,
        },
        abonos: [
          {
            movimiento_id: M.PAYWISE_293,
            fecha: '2026-09-11',
            tipo: 'ABONO',
            monto: 11870.24,
            moneda: 'MXN',
            descripcion: 'DIEGO FRANCISCO,BELTRAN/COLLADO : dbc cozcan 20sep',
            referencia: null,
            conciliado: true,
            origen: 'IMPORTADO',
            creado_at: '2026-09-24T19:46:03.346932+00:00',
            creado_por: 'Alejandro Canales',
            orden_archivo: null,
            cuenta: PAYWISE,
            estado_cuenta: {
              id: EC.PAYWISE_24SEP,
              filename: 'Reporte de Movimientos Septiembre-2026.pdf',
              formato: 'pdf',
              importado_at: '2026-09-24T19:46:03.233773+00:00',
              importado_por: 'Alejandro Canales',
              movimientos_importados: 34,
            },
            sin_archivo: null,
            monto_bruto: null,
            comision_pasarela: null,
            liga: {
              via: 'DIRECTO',
              monto_parte: 11870.24,
              moneda: 'MXN',
              cruzada: false,
              tc_implicito: null,
              cuadre: null,
              registro: null,
              sin_registro: 'ANTERIOR_AL_CORTE',
            },
            lote: null,
            notas_oficina: null,
          },
        ],
        sobre: null,
        anticipo: null,
        alertas: [],
        ultimos_movimientos: null,
        mismo_dia_cliente: null,
        cruce_no_corrio: null,
        varios_abonos_por_cobro: false,
      }),
    );
  });

  it('d bis) #358 (variante de centavos): parte 38,950.00 contra neto 38,950.01 ⇒ cubierto con faltante 0.01', async () => {
    const r = await cobro(armar(mundoProd()).svc, C.C358);
    expect(r.cobertura).toEqual({
      neto: 38950.01,
      monto_vinculado: 38950,
      faltante: 0.01,
      sobrante: 0,
      cubierto: true,
      abonos_n: 1,
      cruzado: false,
      tolerancia: 1,
    });
    expect(r.abonos[0]).toMatchObject({
      estado_cuenta: {
        filename: 'Reporte de Movimientos paywise Septiembre-2026.pdf',
      },
      liga: { monto_parte: 38950, sin_registro: 'ANTERIOR_AL_CORTE' },
    });
  });

  it('e) #332 dentro del SPEI de $69,183.00: el lote COMPLETO de GET movimientos («este cobro» incluido), Diego Ramírez; desde #315 el MISMO abono y lote con «anterior al corte»', async () => {
    const { svc } = armar(mundoProd());
    const r = await cobro(svc, C.C332);
    expect(r).toMatchObject({
      estado: 'CONCILIADO',
      via: 'DIRECTO',
      fuente: 'PUENTE',
      cobertura: {
        neto: 977.45,
        monto_vinculado: 977.45,
        faltante: 0,
        cubierto: true,
        abonos_n: 1,
      },
      alertas: [],
      varios_abonos_por_cobro: true,
      entrada: {
        cliente_nombre: 'Beh Kay ',
        tc_usd_mxn: 17.15,
        cuenta_destino: 'Scotiabank Pesos',
        registrado_por_nombre: 'Itzi',
      },
    });
    expect(r.abonos).toHaveLength(1);
    const a = r.abonos[0];
    expect(a).toMatchObject({
      movimiento_id: M.LOTE_69183,
      monto: 69183,
      descripcion: 'TRANSF INTERBANCARIA SPEI',
      referencia: '00000000000000150926',
      cuenta: EJE,
      estado_cuenta: {
        filename: 'scotia eje sep.pdf',
        importado_por: 'Alejandro Canales',
        movimientos_importados: 98,
      },
      liga: {
        via: 'DIRECTO',
        monto_parte: 977.45,
        registro: {
          por: 'Diego Ramírez',
          at: '2026-10-14T21:21:49.025963+00:00',
        },
        sin_registro: null,
      },
    });
    const ficha = (cobroId: string, folio: number, monto: number) => ({
      cobro_id: cobroId,
      monto_parte: monto,
      vuelo_id: VUELO[folio],
      folio,
      cliente: 'Beh Kay ',
      fecha_cobro: '2026-09-15T17:00:00+00:00',
      monto,
      moneda: 'MXN',
      metodo_cobro: 'TRANSFERENCIA',
      comision_banco_monto: null,
      neto: monto,
      // Aditivos del 0.0.78 (anotarCobrosDeAbonos, fase 2), sin código extra.
      cobro_estado: 'CONCILIADO',
      cobro_neto: monto,
      cobro_faltante: 0,
      cobro_abonos_n: 1,
    });
    expect(a.lote).toEqual({
      cobros_n: 2,
      cobros: [ficha(C.C315, 315, 68205.55), ficha(C.C332, 332, 977.45)],
      cobros_suma: 69183,
      cobros_diferencia: 0,
    });
    const desde315 = await cobro(svc, C.C315);
    expect(desde315.abonos[0].movimiento_id).toBe(M.LOTE_69183);
    expect(desde315.abonos[0].lote).toEqual(a.lote);
    expect(desde315.abonos[0].liga).toMatchObject({
      monto_parte: 68205.55,
      registro: null,
      sin_registro: 'ANTERIOR_AL_CORTE',
    });
    // Lote de $55,053.00: #254 (Alejandro) y #255 (Diego).
    expect((await cobro(svc, C.C254)).abonos[0].liga.registro).toEqual({
      por: 'Alejandro Canales',
      at: '2026-10-13T16:51:24.805037+00:00',
    });
    expect((await cobro(svc, C.C255)).abonos[0].liga.registro).toEqual({
      por: 'Diego Ramírez',
      at: '2026-10-14T21:24:23.298278+00:00',
    });
  });

  it('f) anotarCobrosDeAbonos que falla ⇒ lote.cobros null + LOTE_SIN_DETALLE; lo demás intacto', async () => {
    const { svc } = armar(mundoProd(), {
      falla: (t, texto) =>
        t === 'movimiento_bancario_cobro' && texto.includes('in:movimiento_id'),
    });
    const r = await cobro(svc, C.C332);
    expect(r.estado).toBe('CONCILIADO');
    expect(r.abonos[0].lote).toEqual({
      cobros_n: 2,
      cobros: null,
      cobros_suma: null,
      cobros_diferencia: null,
    });
    expect(r.abonos[0].liga.monto_parte).toBe(977.45);
    expect(r.alertas).toEqual(['LOTE_SIN_DETALLE']);
  });

  it('g) #223 $812.00 USD «Sin conciliar»: ejemplo D (cobertura, primera y última fecha de las cuentas ACTIVAS, mismo día de Morena Mia, sin «cruce no corrió»)', async () => {
    const r = await cobro(armar(mundoProd()).svc, C.C223);
    const { ultimos_movimientos, ...resto } = r;
    expect(JSON.stringify(resto)).toBe(
      JSON.stringify({
        entrada: {
          origen: 'COBRO_VUELO',
          id: C.C223,
          etiqueta: 'Vuelo #223',
          categoria: 'COBRO_VUELO',
          categoria_etiqueta: 'Cobro de vuelo',
          dia: '2026-09-10',
          monto: 812,
          comision: null,
          neto: 812,
          moneda: 'USD',
          tc_usd_mxn: null,
          metodo: 'TRANSFERENCIA',
          metodo_etiqueta: 'Transferencia',
          cliente_nombre: 'Morena Mia',
          concepto: null,
          vuelo_id: VUELO[223],
          vuelo_folio: 223,
          cuenta: null,
          cuenta_destino: 'HSBC Dólares',
          registrado_por_nombre: 'Itzi',
          registrado_at: '2026-09-17T21:14:16.291733+00:00',
          es_reembolso: false,
          dado_de_baja: false,
        },
        estado: 'SIN_CONCILIAR',
        via: null,
        fuente: 'PUENTE',
        cobertura: {
          neto: 812,
          monto_vinculado: 0,
          faltante: 812,
          sobrante: 0,
          cubierto: false,
          abonos_n: 0,
          cruzado: false,
          tolerancia: 1,
        },
        abonos: [],
        sobre: null,
        anticipo: null,
        alertas: [],
        mismo_dia_cliente: {
          cliente: 'Morena Mia',
          dia: '2026-09-10',
          moneda: 'USD',
          cobros: [
            {
              cobro_id: C.C198,
              vuelo_id: VUELO[198],
              folio: 198,
              monto: 783,
              neto: 783,
            },
            {
              cobro_id: C.C226,
              vuelo_id: VUELO[226],
              folio: 226,
              monto: 812,
              neto: 812,
            },
          ],
          n: 2,
          suma_netos: 2407,
        },
        cruce_no_corrio: null,
        varios_abonos_por_cobro: true,
      }),
    );
    // SCOTIA USD (inactiva) no aparece; afirme, AmEx Ale y la tarjeta sin movimientos ⇒ null.
    expect(porAlias(ultimos_movimientos)).toEqual(porAlias(ULTIMOS_PROD));
    expect(Object.keys(ultimos_movimientos![0])).toEqual([
      'cuenta',
      'primera_fecha',
      'ultima_fecha',
    ]);
  });

  it('h) PARCIAL (sintético, Beh Kay $3,400 con UN SPEI) y CONCILIADO con DOS (dos tarjetas, cada una con su registro)', async () => {
    const parcial = await cobro(
      armar(conParcial(mundoProd(), false)).svc,
      BEH_3400,
    );
    expect(parcial).toMatchObject({
      estado: 'PARCIAL',
      via: 'DIRECTO',
      fuente: 'PUENTE',
      cobertura: {
        neto: 3400,
        monto_vinculado: 1700,
        faltante: 1700,
        sobrante: 0,
        cubierto: false,
        abonos_n: 1,
        cruzado: false,
        tolerancia: 1,
      },
      alertas: [],
      mismo_dia_cliente: null,
      cruce_no_corrio: null,
      varios_abonos_por_cobro: true,
    });
    expect(parcial.abonos.map((a) => a.liga.monto_parte)).toEqual([1700]);
    expect(porAlias(parcial.ultimos_movimientos)).toHaveLength(9);
    const dos = await cobro(armar(conParcial(mundoProd(), true)).svc, BEH_3400);
    expect(dos).toMatchObject({
      estado: 'CONCILIADO',
      cobertura: {
        monto_vinculado: 3400,
        faltante: 0,
        cubierto: true,
        abonos_n: 2,
      },
      ultimos_movimientos: null,
    });
    expect(
      dos.abonos.map((a) => [
        a.movimiento_id,
        a.fecha,
        a.liga.monto_parte,
        a.liga.registro?.por,
      ]),
    ).toEqual([
      [SPEI_1, '2026-09-20', 1700, 'Alejandro Canales'],
      [SPEI_2, '2026-09-21', 1700, 'Diego Ramírez'],
    ]);
  });

  it('i) vía SOBRE (sintético): CONCILIADO, COLUMNA, NO_SE_GUARDA, aviones_n; el conteo que falla ⇒ 0 y 200', async () => {
    const r = await cobro(armar(conSobre(mundoProd())).svc, PARTE_SOBRE);
    expect(r).toMatchObject({
      estado: 'CONCILIADO',
      via: 'SOBRE',
      fuente: 'COLUMNA',
      cobertura: null,
      anticipo: null,
      mismo_dia_cliente: null,
      cruce_no_corrio: null,
      ultimos_movimientos: null,
      varios_abonos_por_cobro: false,
    });
    expect(r.sobre).toEqual({
      tipo: 'SOBRE_GRUPO',
      cobro_grupo_id: SOBRE,
      grupo_id: 'g-boda',
      grupo_folio: 4,
      grupo_nombre: 'Boda Pérez',
      monto: 10800.76,
      moneda: 'MXN',
      metodo: 'TRANSFERENCIA',
      metodo_cobro: 'TRANSFERENCIA',
      fecha: '2026-09-18T17:00:00+00:00',
      fecha_cobro: '2026-09-18T17:00:00+00:00',
      referencia: null,
      comision_banco_monto: null,
      neto: 10800.76,
      aviones_n: 3,
    });
    expect(r.abonos).toHaveLength(1);
    expect(r.abonos[0]).toMatchObject({
      movimiento_id: ABONO_SOBRE,
      lote: null,
    });
    expect(r.abonos[0].liga).toEqual({
      via: 'SOBRE',
      monto_parte: null,
      moneda: 'MXN',
      cruzada: false,
      tc_implicito: null,
      cuadre: null,
      registro: null,
      sin_registro: 'NO_SE_GUARDA',
    });
    const caido = await cobro(
      armar(conSobre(mundoProd()), {
        falla: (t, texto) =>
          t === 'cobro_vuelo' && texto.includes('in:cobro_grupo_id'),
      }).svc,
      PARTE_SOBRE,
    );
    expect(caido.estado).toBe('CONCILIADO');
    expect(caido.sobre?.aviones_n).toBe(0);
    // Parte de un sobre SIN ligar: SIN_CONCILIAR, sin cobertura ni «mismo día».
    const libre = await cobro(
      armar(conSobre(mundoProd(), false)).svc,
      PARTE_SOBRE,
    );
    expect(libre).toMatchObject({
      estado: 'SIN_CONCILIAR',
      via: null,
      fuente: 'PUENTE',
      cobertura: null,
      abonos: [],
      mismo_dia_cliente: null,
      cruce_no_corrio: null,
    });
    expect(libre.sobre?.aviones_n).toBe(3);
  });

  it('j) vía ANTICIPO (sintético): VIA_ANTICIPO con el registro de SU bitácora; anticipo sin conciliar ⇒ SIN_CONCILIAR con su bloque', async () => {
    const r = await cobro(armar(conAnticipo(mundoProd())).svc, COBRO_ANT);
    expect(r).toMatchObject({
      estado: 'VIA_ANTICIPO',
      via: 'ANTICIPO',
      fuente: 'COLUMNA',
      cobertura: null,
      sobre: null,
      ultimos_movimientos: null,
      varios_abonos_por_cobro: false,
    });
    expect(r.anticipo).toEqual({
      ingreso_id: ING12,
      etiqueta: 'ING-12',
      monto: 50000,
      moneda: 'MXN',
      dia: '2026-09-01',
      cuenta_bancaria_id: CTA.EJE_SCOTIA,
      conciliado: true,
    });
    expect(r.abonos.map((a) => a.movimiento_id)).toEqual([ABONO_ANT]);
    expect(r.abonos[0].liga).toEqual({
      via: 'ANTICIPO',
      monto_parte: null,
      moneda: 'MXN',
      cruzada: false,
      tc_implicito: null,
      cuadre: null,
      registro: { por: 'Diego Ramírez', at: '2026-10-13T12:00:00+00:00' },
      sin_registro: null,
    });
    const sin = await cobro(
      armar(conAnticipo(mundoProd(), false)).svc,
      COBRO_ANT,
    );
    expect(sin).toMatchObject({
      estado: 'SIN_CONCILIAR',
      via: null,
      abonos: [],
      anticipo: { etiqueta: 'ING-12', conciliado: false },
      cobertura: null,
      mismo_dia_cliente: null,
      cruce_no_corrio: null,
    });
    expect(sin.ultimos_movimientos).not.toBeNull();
    // El anticipo como fila de Ingresos entra por `ingresos/:id`.
    const comoIngreso = await ingreso(
      armar(conAnticipo(mundoProd())).svc,
      ING12,
    );
    expect(comoIngreso).toMatchObject({
      estado: 'CONCILIADO',
      via: 'INGRESO',
      entrada: {
        etiqueta: 'ING-12',
        categoria: 'ANTICIPO_CLIENTE',
        cliente_nombre: 'Palma',
      },
    });
  });

  it('k) 404 COBRO_NO_EXISTE / INGRESO_NO_EXISTE; un ingreso de baja ⇒ 200 con dado_de_baja', async () => {
    const { svc } = armar(mundoProd());
    const c404 = await respuestaDe(
      cobro(svc, 'C0000000-0000-4000-8000-00000000DEAD'),
    );
    expect(c404.e).toBeInstanceOf(NotFoundException);
    expect(c404).toMatchObject({
      code: 'COBRO_NO_EXISTE',
      message: 'Ese cobro ya no existe: recarga la página.',
    });
    const i404 = await respuestaDe(
      ingreso(svc, 'c0000000-0000-4000-8000-00000000dead'),
    );
    expect(i404).toMatchObject({
      code: 'INGRESO_NO_EXISTE',
      message: 'Ese ingreso ya no existe: recarga la página.',
    });
    const db = mundoProd();
    db.ingreso.find((i) => i.id === ING.ING2)!.deleted_at =
      '2026-10-14T12:00:00+00:00';
    const baja = await ingreso(armar(db).svc, ING.ING2);
    expect(baja).toMatchObject({
      estado: 'NO_BANCARIO',
      via: null,
      abonos: [],
      ultimos_movimientos: null,
      entrada: { dado_de_baja: true, etiqueta: 'ING-2', cuenta: null },
    });
    // El uuid se normaliza a minúsculas (como los devuelve la BD).
    expect((await cobro(svc, C.C293.toUpperCase())).entrada.id).toBe(C.C293);
  });

  it('l) SIN la migración de ingresos: ingresos/:id ⇒ 503; cobros/:id ⇒ 200 y NINGUNA consulta nombra ingreso_id, ingreso_anticipo_id, ingreso ni ingreso_bitacora', async () => {
    const f = armar(mundoProd(), SIN_INGRESOS);
    const e = await respuestaDe(ingreso(f.svc, ING.ING3));
    expect(e.e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.code).toBe('INGRESOS_NO_DISPONIBLE');
    const desde = f.log.length;
    for (const id of [C.C379, C.C332, C.C293]) {
      const r = await cobro(f.svc, id);
      expect(r.anticipo).toBeNull();
    }
    const r379 = await cobro(f.svc, C.C379);
    expect(r379.mismo_dia_cliente).toMatchObject({ n: 1, suma_netos: 59081 });
    const qs = deNegocio(f.log.slice(desde));
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      expect(q.tabla).not.toMatch(/^ingreso/);
      expect(q.texto).not.toMatch(
        /\bingreso_id\b|ingreso_anticipo_id|\bingreso\b|ingreso_bitacora/,
      );
    }
  });

  it('m) SIN la puente (20261012000002): ESPEJO, parte SINTÉTICA = |abono|, sin registro ni lote, y nada nombra cobros_n ni la puente', async () => {
    const f = armar(mundoProd(), SIN_PUENTE);
    const r = await cobro(f.svc, C.C293);
    expect(r).toMatchObject({
      estado: 'CONCILIADO',
      via: 'DIRECTO',
      fuente: 'ESPEJO',
    });
    expect(r.abonos[0].liga).toMatchObject({
      monto_parte: 11870.24,
      registro: null,
      sin_registro: null,
    });
    expect(r.abonos[0].lote).toBeNull();
    expect((await cobro(f.svc, C.C223)).fuente).toBe('ESPEJO');
    for (const q of deNegocio(f.log)) {
      expect(q.tabla).not.toBe('movimiento_bancario_cobro');
      expect(q.texto).not.toMatch(/cobros_n/);
    }
  });

  it('n) la entrada, las ligas o los movimientos que fallan ⇒ se LANZA (jamás «sin abonos»)', async () => {
    const casos: Array<
      [string, OpcionesFakeEntradas['falla'], OrigenEntrada, string]
    > = [
      [
        'cobro',
        (t, x) => t === 'cobro_vuelo' && x.includes('eq:id'),
        'COBRO_VUELO',
        C.C293,
      ],
      [
        'puente',
        (t) => t === 'movimiento_bancario_cobro',
        'COBRO_VUELO',
        C.C293,
      ],
      [
        'espejo',
        (t, x) => t === 'movimiento_bancario' && x.includes('in:cobro_id'),
        'COBRO_VUELO',
        C.C293,
      ],
      [
        'abonos',
        (t, x) => t === 'movimiento_bancario' && x.includes('in:id'),
        'COBRO_VUELO',
        C.C293,
      ],
      ['ingreso', (t) => t === 'ingreso', 'INGRESO', ING.ING3],
      [
        'abono del ingreso',
        (t, x) => t === 'movimiento_bancario' && x.includes('eq:ingreso_id'),
        'INGRESO',
        ING.ING3,
      ],
    ];
    for (const [, falla, origen, id] of casos) {
      const { svc } = armar(mundoProd(), { falla });
      await expect(svc.conciliacionDeEntrada(origen, id)).rejects.toThrow(
        'caída',
      );
    }
  });

  it('o) carrera: la liga existe pero su abono ya no se lee ⇒ se OMITE con warn y CONCILIADO_SIN_ABONOS', async () => {
    const db = mundoProd();
    db.movimiento_bancario = db.movimiento_bancario.filter(
      (m) => m.id !== M.PAYWISE_293,
    );
    const r = await cobro(armar(db).svc, C.C293);
    expect(r.estado).toBe('CONCILIADO');
    expect(r.abonos).toEqual([]);
    expect(r.alertas).toEqual(['CONCILIADO_SIN_ABONOS']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `el abono ${M.PAYWISE_293} del cobro ${C.C293} ya no se pudo leer`,
      ),
    );
  });

  it('p) CERO escrituras (ni insert/update/delete ni otra RPC que la sonda) y q) ningún select nombra datos sensibles ni sale VENENO', async () => {
    const db = conAnticipo(conSobre(conParcial(mundoProd(), false)));
    const f = armar(db);
    const respuestas: ConciliacionDeEntradaRespuesta[] = [];
    for (const id of [
      C.C293,
      C.C332,
      C.C315,
      C.C223,
      C.C379,
      C.C383,
      C.C349,
      C.C375,
      BEH_3400,
      PARTE_SOBRE,
      COBRO_ANT,
    ]) {
      respuestas.push(await cobro(f.svc, id));
    }
    for (const id of [ING.ING2, ING.ING3, ING.ING4, ING.ING7, ING12]) {
      respuestas.push(await ingreso(f.svc, id));
    }
    expect(f.escrituras()).toEqual([]);
    for (const q of f.log) {
      expect(q.texto).not.toMatch(
        /numero_cuenta|clabe|storage_path|foto_voucher_url|archivo_path|snapshot/,
      );
      // La ruta jamás nombra los objetos del 0.0.78 por su cuenta (solo su sonda).
      expect(`${q.tabla} ${q.texto}`).not.toMatch(
        /v_cobro_conciliacion|pago_parcial|neto_de_cobro/,
      );
      // Del ingreso jamás sus notas crudas (del cobro sí: `conceptoDeCobro`).
      if (q.tabla === 'ingreso') expect(q.texto).not.toMatch(/\bnotas\b/);
    }
    for (const r of respuestas) {
      expect(JSON.stringify(r)).not.toMatch(
        /VENENO|storage_path|numero_cuenta|clabe|foto_voucher_url|archivo_path|snapshot/,
      );
    }
  });

  it('r) orden_archivo SOLO con su sonda', async () => {
    const con = armar(mundoProd());
    await cobro(con.svc, C.C332);
    expect(
      con.log.some(
        (q) =>
          q.tabla === 'movimiento_bancario' &&
          q.texto.includes(', cobros_n, ingreso_id, orden_archivo)'),
      ),
    ).toBe(true);
    const sin = armar(mundoProd(), { ausentes: ['orden_archivo'] });
    const r = await cobro(sin.svc, C.C332);
    expect(r.abonos[0].orden_archivo).toBeNull();
    const ri = await ingreso(sin.svc, ING.ING3);
    expect(ri.abonos[0].orden_archivo).toBeNull();
    expect(
      deNegocio(sin.log).filter((q) => /orden_archivo/.test(q.texto)),
    ).toEqual([]);
  });

  it('s) ultimosMovimientosPorCuenta() SIN opción = la de Gastos (sin primera_fecha, una consulta por cuenta); con conPrimera, la del ejemplo D', async () => {
    const f = armar(mundoProd());
    const priv = f.svc as unknown as {
      ultimosMovimientosPorCuenta: (o?: {
        conPrimera?: boolean;
      }) => Promise<UltimoMovimientoCuenta[] | null>;
    };
    const desde = f.log.length;
    const gastos = await priv.ultimosMovimientosPorCuenta();
    const qsGastos = f.log.slice(desde);
    expect(gastos).toHaveLength(9);
    for (const u of gastos!)
      expect(Object.keys(u)).toEqual(['cuenta', 'ultima_fecha']);
    expect(
      qsGastos.filter((q) => q.tabla === 'movimiento_bancario'),
    ).toHaveLength(9);
    expect(
      qsGastos.every((q) =>
        q.orden.every(
          ([, asc]) => q.tabla !== 'movimiento_bancario' || asc === false,
        ),
      ),
    ).toBe(true);
    const desde2 = f.log.length;
    const conPrimera = await priv.ultimosMovimientosPorCuenta({
      conPrimera: true,
    });
    expect(
      f.log.slice(desde2).filter((q) => q.tabla === 'movimiento_bancario'),
    ).toHaveLength(18);
    expect(porAlias(conPrimera)).toEqual(porAlias(ULTIMOS_PROD));
    expect(gastos!.map((u) => u.ultima_fecha)).toEqual(
      conPrimera!.map((u) => u.ultima_fecha),
    );
    // La lectura de cuentas que falla ⇒ null (best-effort).
    const caida = armar(mundoProd(), { falla: (t) => t === 'cuenta_bancaria' });
    const r = await cobro(caida.svc, C.C223);
    expect(r.ultimos_movimientos).toBeNull();
    expect(r.estado).toBe('SIN_CONCILIAR');
  });

  it('t) ABONO_CON_SOBRANTE con una liga vieja (sintético: cobro de $1,000.00 con un abono de $1,500.00)', async () => {
    const db = conParcial(mundoProd(), false);
    const c = db.cobro_vuelo.find((x) => x.id === BEH_3400)!;
    c.monto = 1000;
    db.movimiento_bancario.find((m) => m.id === SPEI_1)!.monto = 1500;
    db.movimiento_bancario_cobro.find(
      (p) => p.movimiento_id === SPEI_1,
    )!.monto_parte = 1500;
    const r = await cobro(armar(db).svc, BEH_3400);
    expect(r).toMatchObject({
      estado: 'CONCILIADO',
      cobertura: {
        neto: 1000,
        monto_vinculado: 1500,
        sobrante: 500,
        cubierto: true,
      },
      alertas: ['ABONO_CON_SOBRANTE'],
    });
  });

  it('u) varios_abonos_por_cobro = la sonda del 0.0.78 Y la regla «de un solo abono»', async () => {
    const on = armar(mundoProd());
    expect((await cobro(on.svc, C.C332)).varios_abonos_por_cobro).toBe(true);
    expect((await cobro(on.svc, C.C223)).varios_abonos_por_cobro).toBe(true);
    expect((await cobro(on.svc, C.C379)).varios_abonos_por_cobro).toBe(true);
    // PAYWISE con comisión y HSBC_LINK con comisión: de UN solo abono.
    expect((await cobro(on.svc, C.C293)).varios_abonos_por_cobro).toBe(false);
    expect((await cobro(on.svc, C.C358)).varios_abonos_por_cobro).toBe(false);
    expect((await cobro(on.svc, C.C375)).varios_abonos_por_cobro).toBe(false);
    // #349: «Transferencia» con comisión (cuenta capturada «Paywise»).
    expect((await cobro(on.svc, C.C349)).varios_abonos_por_cobro).toBe(false);
    expect((await ingreso(on.svc, ING.ING3)).varios_abonos_por_cobro).toBe(
      false,
    );
    // Sonda apagada (20261014000003 sin aplicar) ⇒ false en todos.
    const off = armar(mundoProd(), { sinParciales: true });
    for (const id of [C.C332, C.C223, C.C379]) {
      expect((await cobro(off.svc, id)).varios_abonos_por_cobro).toBe(false);
    }
  });

  it('u bis) la sonda FALLA sin decir «no está» (timeout, red, excepción) ⇒ varios_abonos_por_cobro false y la hoja responde 200 (modo estricto, revisión del 15-oct-2026)', async () => {
    for (const falla of ['timeout', 'red', 'excepcion'] as const) {
      const f = armar(mundoProd(), { sondaParcialesFalla: falla });
      for (const id of [C.C332, C.C223, C.C379]) {
        const r = await cobro(f.svc, id);
        expect([falla, id, r.varios_abonos_por_cobro]).toEqual([
          falla,
          id,
          false,
        ]);
      }
      expect(f.escrituras()).toEqual([]);
    }
    // La sonda avisó que no tuvo respuesta clara (un warn por instancia).
    expect(
      (warn.mock.calls as unknown[][]).some((c) =>
        String(c[0]).includes('sin respuesta clara'),
      ),
    ).toBe(true);
  });

  it('v) mismo_dia_cliente de #379 (Palma): vuelos del cliente paginados + cobros del día por lotes; los ligados fuera; la lectura que falla ⇒ null y 200', async () => {
    const f = armar(mundoProd());
    const desde = f.log.length;
    const r = await cobro(f.svc, C.C379);
    expect(r.mismo_dia_cliente).toEqual({
      cliente: 'Palma',
      dia: '2026-10-06',
      moneda: 'MXN',
      cobros: [
        {
          cobro_id: C.C380,
          vuelo_id: VUELO[380],
          folio: 380,
          monto: 29540.5,
          neto: 29540.5,
        },
      ],
      n: 1,
      suma_netos: 59081,
    });
    expect(r.cruce_no_corrio).toBeNull();
    const qs = f.log.slice(desde);
    const vuelos = qs.find((q) => q.tabla === 'vuelo')!;
    expect(vuelos.filtros).toEqual([['eq', 'cliente_id', K.PALMA]]);
    expect(vuelos.orden).toEqual([['id', true]]);
    expect(vuelos.rango).toEqual([0, 999]);
    const cobrosDia = qs.find(
      (q) => q.tabla === 'cobro_vuelo' && q.texto.includes('in:vuelo_id'),
    )!;
    expect(cobrosDia.filtros).toEqual([
      [
        'in',
        'vuelo_id',
        expect.arrayContaining([
          VUELO[254],
          VUELO[255],
          VUELO[379],
          VUELO[380],
        ]),
      ],
      ['gte', 'fecha_cobro', '2026-10-06T00:00:00-05:00'],
      ['lte', 'fecha_cobro', '2026-10-06T23:59:59-05:00'],
      ['eq', 'moneda', 'MXN'],
      ['gt', 'monto', 0],
      [
        'in',
        'metodo_cobro',
        ['TRANSFERENCIA', 'HSBC_LINK', 'CHEQUE', 'PAYWISE'],
      ],
      ['is', 'cobro_grupo_id', null],
      ['neq', 'id', C.C379],
      ['is', 'ingreso_anticipo_id', null],
    ]);
    expect(cobrosDia.rango).toEqual([0, 999]);
    // #254 y #255 (Palma, 07-sep) están ligados al lote de $55,053.00: el
    // «mismo día» de #254 no ofrece a #255.
    expect((await cobro(f.svc, C.C254)).mismo_dia_cliente).toBeNull();
    const db = mundoProd();
    db.movimiento_bancario_cobro = db.movimiento_bancario_cobro.filter(
      (p) => p.cobro_id !== C.C254,
    );
    db.movimiento_bancario.find((m) => m.id === M.LOTE_55053)!.cobros_n = 1;
    const r254 = await cobro(armar(db).svc, C.C254);
    expect(r254.estado).toBe('SIN_CONCILIAR');
    expect(r254.mismo_dia_cliente).toBeNull();
    const caido = await cobro(
      armar(mundoProd(), { falla: (t) => t === 'vuelo' }).svc,
      C.C379,
    );
    expect(caido.estado).toBe('SIN_CONCILIAR');
    expect(caido.mismo_dia_cliente).toBeNull();
  });

  it('w) cruce_no_corrio de #383 = {4, 05-oct, 11-oct}: UN count (head) de abonos PENDIENTES de las cuentas ACTIVAS en pesos importados antes de registrarlo; #223 ⇒ null; falla ⇒ null y 200', async () => {
    const f = armar(mundoProd());
    const desde = f.log.length;
    const r = await cobro(f.svc, C.C383);
    expect(r.cruce_no_corrio).toEqual({
      abonos_previos: 4,
      desde: '2026-10-05',
      hasta: '2026-10-11',
    });
    expect(r.mismo_dia_cliente).toBeNull();
    const conteo = f.log.slice(desde).find((q) => q.head)!;
    expect(conteo).toMatchObject({
      tabla: 'movimiento_bancario',
      count: 'exact',
      sel: 'id',
    });
    expect(conteo.filtros).toEqual([
      ['eq', 'tipo', 'ABONO'],
      ['eq', 'conciliado', false],
      [
        'in',
        'cuenta_bancaria_id',
        [
          CTA.HSBC_PESOS,
          CTA.COMBUSTIBLE,
          CTA.EJE_SCOTIA,
          CTA.AFIRME,
          CTA.GASTOS_GNRAL,
          CTA.AMEX_ALE,
          CTA.TARJETA_CREDITO_HSBC,
        ],
      ],
      ['gte', 'fecha', '2026-10-05'],
      ['lte', 'fecha', '2026-10-11'],
      ['lt', 'created_at', '2026-10-08T18:43:29.809678+00:00'],
    ]);
    // #223: sus abonos se importaron DESPUÉS de registrarlo ⇒ null.
    expect((await cobro(f.svc, C.C223)).cruce_no_corrio).toBeNull();
    // PAYWISE ⇒ ventana de 5 días y cuentas PASARELA (sintético: #358 sin su abono).
    const db = mundoProd();
    db.movimiento_bancario_cobro = db.movimiento_bancario_cobro.filter(
      (p) => p.cobro_id !== C.C358,
    );
    Object.assign(db.movimiento_bancario.find((m) => m.id === M.PAYWISE_358)!, {
      cobro_id: null,
      conciliado: false,
      cobros_n: 0,
    });
    const g = armar(db);
    const d2 = g.log.length;
    const r358 = await cobro(g.svc, C.C358);
    expect(r358.estado).toBe('SIN_CONCILIAR');
    const conteoPw = g.log.slice(d2).find((q) => q.head)!;
    expect(conteoPw.filtros).toEqual(
      expect.arrayContaining([
        ['in', 'cuenta_bancaria_id', [CTA.PAYWISE]],
        ['gte', 'fecha', '2026-09-25'],
        ['lte', 'fecha', '2026-10-05'],
      ]),
    );
    const caido = await cobro(
      armar(mundoProd(), {
        falla: (t, x) =>
          t === 'movimiento_bancario' && x.includes('lt:created_at'),
      }).svc,
      C.C383,
    );
    expect(caido.estado).toBe('SIN_CONCILIAR');
    expect(caido.cruce_no_corrio).toBeNull();
  });

  it('RC5) #349 «Transferencia» con cuenta capturada «Paywise»: el texto capturado TAL CUAL y la PASARELA en lo importado (el panel decide la nota; el API no infiere nada de `cuenta_destino`)', async () => {
    const f = armar(mundoProd());
    const desde = f.log.length;
    const r = await cobro(f.svc, C.C349);
    expect(r).toMatchObject({
      estado: 'SIN_CONCILIAR',
      entrada: {
        metodo: 'TRANSFERENCIA',
        cuenta_destino: 'Paywise',
        comision: 572,
        neto: 10868,
        tc_usd_mxn: 17.6,
      },
      cobertura: { neto: 10868, faltante: 10868, abonos_n: 0 },
      varios_abonos_por_cobro: false,
      mismo_dia_cliente: null,
      // El abono Paywise exacto (80f34938) se importó ANTES de registrarlo,
      // pero «Cruzar pendientes» no lo ligaría (la pasarela solo cruza
      // PAYWISE): la ventana mira las cuentas BANCO de su moneda.
      cruce_no_corrio: null,
    });
    expect(
      r.ultimos_movimientos?.find((u) => u.cuenta.tipo === 'PASARELA'),
    ).toEqual({
      cuenta: PAYWISE,
      primera_fecha: '2026-09-01',
      ultima_fecha: '2026-09-30',
    });
    const conteo = f.log.slice(desde).find((q) => q.head)!;
    expect(conteo.filtros).toEqual(
      expect.arrayContaining([
        ['gte', 'fecha', '2026-09-22'],
        ['lte', 'fecha', '2026-09-28'],
        ['lt', 'created_at', '2026-09-26T18:34:08.462162+00:00'],
      ]),
    );
    const cuentas = conteo.filtros.find(
      ([, col]) => col === 'cuenta_bancaria_id',
    )![2] as string[];
    expect(cuentas).not.toContain(CTA.PAYWISE);
  });

  it('x) un ingreso ⇒ mismo_dia_cliente y cruce_no_corrio null SIN ninguna consulta extra', async () => {
    const f = armar(mundoProd());
    const desde = f.log.length;
    const r = await ingreso(f.svc, ING.ING3);
    expect(r).toMatchObject({ mismo_dia_cliente: null, cruce_no_corrio: null });
    const qs = deNegocio(f.log.slice(desde));
    expect(
      qs.some(
        (q) =>
          q.tabla === 'vuelo' ||
          q.tabla === 'cobro_vuelo' ||
          q.head ||
          q.tabla.startsWith('rpc:'),
      ),
    ).toBe(false);
    // Un ingreso con cuenta y SIN abono ⇒ SIN_CONCILIAR con lo importado por cuenta.
    const db = mundoProd();
    db.movimiento_bancario.find((m) => m.id === M.DIDI_78)!.ingreso_id = null;
    const sin = await ingreso(armar(db).svc, ING.ING3);
    expect(sin).toMatchObject({
      estado: 'SIN_CONCILIAR',
      via: null,
      abonos: [],
      alertas: [],
      mismo_dia_cliente: null,
      cruce_no_corrio: null,
    });
    expect(porAlias(sin.ultimos_movimientos)).toEqual(porAlias(ULTIMOS_PROD));
  });
});

describe('PARIDAD lista de Ingresos ↔ hoja (el MISMO fake)', () => {
  it('estado (+ parcial ⇒ PARCIAL), neto, concepto, etiqueta, día y cliente iguales en TODAS las entradas', async () => {
    const db = conAnticipo(conSobre(conParcial(mundoProd(), false)));
    const f = fakeEntradas(db);
    const conciliacion = new ConciliacionService(
      { get: () => '' } as unknown as ConstructorParameters<
        typeof ConciliacionService
      >[0],
      f.supabase,
      {} as PyservicesService,
      { registrar: jest.fn() } as unknown as IaUsoService,
    );
    const ingresos = new IngresosService(
      f.supabase,
      {
        createCobro: jest.fn(),
        listCobros: jest.fn().mockResolvedValue([]),
      } as unknown as FlightsService,
      conciliacion,
      {} as TipoCambioService,
      { generateTablaXlsx: jest.fn() } as unknown as PyservicesService,
    );
    const lista = await ingresos.entradas({
      desde: '2026-09-01',
      hasta: '2026-10-31',
      limit: 500,
      offset: 0,
    });
    expect(lista.data.length).toBeGreaterThanOrEqual(25);
    const vistos = new Set<string>();
    for (const e of lista.data) {
      const hoja = await conciliacion.conciliacionDeEntrada(e.origen, e.id);
      const estadoLista =
        e.conciliacion.estado === 'SIN_CONCILIAR' && e.conciliacion.parcial
          ? 'PARCIAL'
          : e.conciliacion.estado;
      expect([e.id, hoja.estado]).toEqual([e.id, estadoLista]);
      expect([e.id, hoja.entrada.neto]).toEqual([e.id, e.neto]);
      expect([e.id, hoja.entrada.concepto]).toEqual([e.id, e.concepto]);
      expect([
        e.id,
        hoja.entrada.etiqueta,
        hoja.entrada.dia,
        hoja.entrada.cliente_nombre,
      ]).toEqual([e.id, e.etiqueta, e.dia, e.cliente_nombre]);
      vistos.add(hoja.estado);
    }
    // Cubre los 5 estados de la hoja.
    expect([...vistos].sort()).toEqual([
      'CONCILIADO',
      'NO_BANCARIO',
      'PARCIAL',
      'SIN_CONCILIAR',
      'VIA_ANTICIPO',
    ]);
    expect(f.escrituras()).toEqual([]);
  }, 30_000);
});
