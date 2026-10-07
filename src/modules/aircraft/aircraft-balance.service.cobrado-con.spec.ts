// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { Logger } from '@nestjs/common';
import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionCobroPayload,
  BalanceAvionPayload,
  BalanceAvionVueloPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  V1,
  fakeSupabase,
  mundoLibros,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * «CÓMO SE COBRÓ» CADA PARCIALIDAD (6-oct-2026, API 0.0.60). Pedido del
 * cliente con el Excel «reporte horas FLOTA»: «Al lado de la columna STATUS,
 * si ya se pagó, que venga la misma información de cómo se cobró, quién lo
 * cobró y, si es posible, a qué cuenta».
 *
 * Contrato: cada cobro de `vuelos[].cobros` gana, AL FINAL y sin mover nada
 * más, `metodo_etiqueta` (etiqueta humana, con el sufijo de parte en
 * multi-avión), `registro` (nombre de quien registró, por el embed
 * `registro:usuario!registrado_por(nombre)` de la MISMA consulta) y
 * `cobrado_con` (la línea armada por `etiquetaCobradoCon`).
 */

const AV2 = 'av-2';
const V3 = 'v-3';

/**
 * Vigencia de las COMISIONES A CARGO DEL AVIÓN (API 0.0.65) POSTERIOR a los
 * vuelos de septiembre de este mundo: aquí se prueba «cómo se cobró» de
 * siempre (pre-vigencia, byte a byte). Con la regla, la nota empieza con
 * «Bruto · comisión banco · neto»: `aircraft-balance.service.comisiones.spec`.
 */
const CONFIG_VIGENCIA_POSTERIOR = {
  fecha: () => Promise.resolve('2026-12-01'),
};

/** Tramo con la forma que leen el libro y la cadena de tacos. */
function tramo(
  id: string,
  vueloId: string,
  orden: number,
  extra: Fila & { fecha: string; avionVuelo: string | null },
): Fila {
  const { fecha, avionVuelo, ...resto } = extra;
  return {
    id,
    vuelo_id: vueloId,
    orden,
    aeronave_id: null,
    cancelada_at: null,
    taco_salida: null,
    taco_llegada: null,
    solo_operativa: false,
    es_ferry: false,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    es_sobrevuelo: false,
    tipo_parada: 'NORMAL',
    pasajeros: 2,
    fecha_salida_plan: fecha,
    taco_salida_obs: null,
    taco_llegada_obs: null,
    taco_obs_updated_by: null,
    taco_obs_updated_at: null,
    vuelo: { fecha_vuelo: fecha, aeronave_id: avionVuelo },
    ...resto,
  };
}

/** Cobro con los datos de «cómo se cobró» (forma del select del balance). */
function cobro(
  id: string,
  vueloId: string,
  extra: Fila & { fecha: string },
): Fila {
  const { fecha, ...resto } = extra;
  return {
    id,
    vuelo_id: vueloId,
    moneda: 'MXN',
    tc_usd_mxn: 20,
    fecha_cobro: fecha,
    comision_banco_monto: null,
    comision_banco_pct: null,
    metodo_cobro: null,
    cuenta_destino: null,
    registrado_por: null,
    registro: null,
    ...resto,
  };
}

/**
 * El mundo de los libros con los cobros del #501 reales en su forma:
 * - c-1 TRANSFERENCIA a Scotiabank Pesos que registró Itzi (cobro completo);
 * - c-2 EFECTIVO sin cuenta que registró Pablo Canales (embed en ARREGLO);
 * - c-3 TRANSFERENCIA a HSBC Dólares de un usuario BORRADO (embed null).
 * Y un #503 MULTI-AVIÓN (AV principal + un tramo del AV2) cobrado por
 * transferencia a Scotiabank Pesos, registró Itzi.
 */
function mundoCobros(): Record<string, Fila[]> {
  const m = mundoLibros();
  const f3 = '2026-09-15T15:00:00+00:00';
  return {
    ...m,
    aeronave: [
      ...m.aeronave,
      {
        id: AV2,
        matricula: 'XB-DOS',
        modelo: 'C206',
        color_calendario: '#10B981',
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ],
    vuelo: [
      ...m.vuelo,
      vuelo2({
        id: V3,
        folio: 503,
        fecha_vuelo: f3,
        destino_iata: 'MID',
        tiempo_cobrable_hr: 2,
        subtotal_vuelo_usd: 2000,
        monto_total_usd: 2000,
        monto_total_mxn: 36000,
      }),
    ],
    escala: [
      ...m.escala,
      tramo('e-3a', V3, 1, { fecha: f3, avionVuelo: AV }),
      tramo('e-3b', V3, 2, {
        fecha: '2026-09-15T18:00:00+00:00',
        avionVuelo: AV,
        aeronave_id: AV2,
        origen_iata: 'MID',
        destino_iata: 'CUN',
      }),
    ],
    cobro_vuelo: [
      cobro('c-1', V1, {
        fecha: '2026-09-10T16:00:00+00:00',
        monto: 20000,
        comision_banco_monto: 350,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Pesos',
        registrado_por: 'u-itzi',
        registro: { nombre: 'Itzi' },
      }),
      cobro('c-2', V1, {
        fecha: '2026-09-11T16:00:00+00:00',
        monto: 10000,
        metodo_cobro: 'EFECTIVO',
        cuenta_destino: '  ',
        registrado_por: 'u-pablo',
        registro: [{ nombre: ' Pablo   Canales ' }],
      }),
      cobro('c-3', V1, {
        fecha: '2026-09-12T16:00:00+00:00',
        monto: 500,
        moneda: 'USD',
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'HSBC Dólares',
        registrado_por: null,
        registro: null,
      }),
      cobro('c-4', V3, {
        fecha: '2026-09-15T20:00:00+00:00',
        monto: 36000,
        tc_usd_mxn: 18,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Pesos',
        registrado_por: 'u-itzi',
        registro: { nombre: 'Itzi' },
      }),
    ],
  };
}

type ErrorPostgrest = { code: string; message: string };

/** Errores que puede inyectar el spec en la lectura de `cobro_vuelo`. */
interface OpcionesCobro {
  /** Falla la consulta CON el embed del nombre. */
  errorEmbed?: ErrorPostgrest;
  /** Falla la consulta SIN el embed (la del respaldo). */
  errorSinEmbed?: ErrorPostgrest;
}

/** Consulta de PostgREST que responde `error` (encadenable como la real). */
function consultaFallida(error: ErrorPostgrest) {
  const q: Record<string, unknown> = {
    in: () => q,
    order: () => q,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error }).then(res, rej),
  };
  return q;
}

/** Supabase del mundo + registro del `select` pedido a `cobro_vuelo`. */
function supabaseCon(mundo: Record<string, Fila[]>, opts: OpcionesCobro = {}) {
  const base = fakeSupabase(mundo);
  const selectsCobro: string[] = [];
  const from = (tabla: string) => {
    const q = base.supabase.service.from(tabla);
    if (tabla === 'cobro_vuelo') {
      const selectOriginal = q.select as (cols?: string) => unknown;
      q.select = (cols?: string) => {
        selectsCobro.push(cols ?? '');
        const falla = (cols ?? '').includes('registro:')
          ? opts.errorEmbed
          : opts.errorSinEmbed;
        return falla ? consultaFallida(falla) : selectOriginal(cols);
      };
    }
    return q;
  };
  return { supabase: { service: { from } }, selectsCobro };
}

function armar(mundo: Record<string, Fila[]>, opts: OpcionesCobro = {}) {
  const s = supabaseCon(mundo, opts);
  const enviados: { individual?: BalanceAvionPayload; general?: unknown } = {};
  const pyservices = {
    generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
      enviados.individual = p;
      return Promise.resolve(Buffer.from('xlsx'));
    },
    generateBalanceGeneralXlsx: (p: unknown) => {
      enviados.general = p;
      return Promise.resolve(Buffer.from('xlsx'));
    },
  };
  const service = new AircraftBalanceService(
    s.supabase as unknown as SupabaseService,
    pyservices as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    CONFIG_VIGENCIA_POSTERIOR as never,
  );
  return { service, enviados, selectsCobro: s.selectsCobro };
}

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
};

const filaDe = (
  vuelos: BalanceAvionVueloPayload[],
  vueloId: string,
): BalanceAvionVueloPayload => {
  const f = vuelos.find((x) => x.vuelo_id === vueloId);
  if (!f) throw new Error(`sin fila del vuelo ${vueloId}`);
  return f;
};

/**
 * Lo que el cliente ve de cada cobro, en el orden del libro — los NÚMEROS
 * incluidos (revisión 6-oct-2026): sin `monto_mxn` y `comision_mxn` aquí, un
 * cambio en el cálculo de la parcialidad pasaba todos los specs.
 */
const comoSeCobro = (cobros: BalanceAvionCobroPayload[]) =>
  cobros.map((c) => ({
    monto_mxn: c.monto_mxn,
    comision_mxn: c.comision_mxn,
    metodo: c.metodo,
    cuenta: c.cuenta,
    metodo_etiqueta: c.metodo_etiqueta,
    registro: c.registro,
    cobrado_con: c.cobrado_con,
  }));

/** Payload sin lo que cambia entre corridas (sello de generación). */
const sinSello = (p: BalanceAvionPayload) => ({ ...p, generado: null });

describe('Balance por avión — «cómo se cobró» cada parcialidad (6-oct-2026, API 0.0.60)', () => {
  it('cobro completo, sin cuenta y sin registro: método → cuenta · Registró: nombre', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    const fila = filaDe(enviados.individual!.vuelos, V1);
    expect(comoSeCobro(fila.cobros)).toEqual([
      {
        monto_mxn: 20000,
        comision_mxn: 350,
        metodo: 'TRANSFERENCIA',
        cuenta: 'Scotiabank Pesos',
        metodo_etiqueta: 'Transferencia',
        registro: 'Itzi',
        cobrado_con: 'Transferencia → Scotiabank Pesos · Registró: Itzi',
      },
      {
        // Cuenta en blanco = sin cuenta; el embed en arreglo también se lee
        // y el nombre sale limpio.
        monto_mxn: 10000,
        comision_mxn: null,
        metodo: 'EFECTIVO',
        cuenta: null,
        metodo_etiqueta: 'Efectivo',
        registro: 'Pablo Canales',
        cobrado_con: 'Efectivo · Registró: Pablo Canales',
      },
      {
        // Usuario borrado (FK on delete set null ⇒ embed null): sin
        // «Registró», jamás un nombre inventado. USD 500 × T.C. 20.
        monto_mxn: 10000,
        comision_mxn: null,
        metodo: 'TRANSFERENCIA',
        cuenta: 'HSBC Dólares',
        metodo_etiqueta: 'Transferencia',
        registro: null,
        cobrado_con: 'Transferencia → HSBC Dólares',
      },
    ]);
    // La comisión del libro = Σ de las comisiones de sus parcialidades.
    expect(enviados.individual!.totales.comision_banco_mxn).toBe(350);
  });

  it('los campos nuevos van AL FINAL de cada cobro (aditivos)', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    const c = filaDe(enviados.individual!.vuelos, V1).cobros[0];
    expect(Object.keys(c)).toEqual([
      'fecha',
      'monto_mxn',
      'metodo',
      'comision_mxn',
      'cuenta',
      'metodo_etiqueta',
      'registro',
      'cobrado_con',
    ]);
  });

  it('cobro sin método, cuenta ni registro (fixture de siempre): los tres en null', async () => {
    const { service, enviados } = armar(mundoLibros());
    await service.xlsx(AV, DESDE, HASTA);
    const fila = filaDe(enviados.individual!.vuelos, V1);
    expect(fila.cobros.length).toBe(2);
    for (const c of fila.cobros) {
      expect(c.metodo).toBeNull();
      expect(c.metodo_etiqueta).toBeNull();
      expect(c.registro).toBeNull();
      expect(c.cobrado_con).toBeNull();
    }
  });

  it('el nombre viaja en la MISMA consulta de cobros (embed por la FK registrado_por)', async () => {
    const { service, selectsCobro } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    expect(selectsCobro).toHaveLength(1);
    expect(selectsCobro[0]).toContain('registrado_por');
    expect(selectsCobro[0]).toContain(
      'registro:usuario!registrado_por(nombre)',
    );
    // Las columnas de siempre siguen ahí.
    for (const col of [
      'metodo_cobro',
      'cuenta_destino',
      'comision_banco_monto',
      'fecha_cobro',
    ]) {
      expect(selectsCobro[0]).toContain(col);
    }
  });

  it('quién registró NO mueve ningún número: con y sin registro el payload es idéntico salvo `registro` y `cobrado_con`', async () => {
    const con = armar(mundoCobros());
    await con.service.xlsx(AV, DESDE, HASTA);
    const mundoSin = mundoCobros();
    mundoSin.cobro_vuelo = mundoSin.cobro_vuelo.map((c) => ({
      ...c,
      registrado_por: null,
      registro: null,
    }));
    const sin = armar(mundoSin);
    await sin.service.xlsx(AV, DESDE, HASTA);
    const quitar = (p: BalanceAvionPayload) =>
      sinSello({
        ...p,
        vuelos: p.vuelos.map((f) => ({
          ...f,
          cobros: f.cobros.map((c) => ({
            ...c,
            registro: null,
            cobrado_con: null,
          })),
        })),
      });
    const pSin = sin.enviados.individual!;
    expect(filaDe(pSin.vuelos, V1).cobros.map((c) => c.cobrado_con)).toEqual([
      'Transferencia → Scotiabank Pesos',
      'Efectivo',
      'Transferencia → HSBC Dólares',
    ]);
    expect(quitar(con.enviados.individual!)).toEqual(quitar(pSin));
  });

  it('multi-avión: `metodo_etiqueta` lleva el MISMO sufijo de parte que `metodo` y `cobrado_con` lo pone al final', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsx(AV, DESDE, HASTA);
    const fila = filaDe(enviados.individual!.vuelos, V3);
    expect(fila.cobros).toHaveLength(1);
    const c = fila.cobros[0];
    // La parte de ESTA fila del depósito de $36,000 (50 %).
    expect(c.monto_mxn).toBe(18000);
    expect(c.comision_mxn).toBeNull();
    expect(c.metodo).toBe(
      'TRANSFERENCIA · parte de esta fila (50 % de la venta del avión)',
    );
    expect(c.metodo_etiqueta).toBe(
      'Transferencia · parte de esta fila (50 % de la venta del avión)',
    );
    expect(c.cuenta).toBe('Scotiabank Pesos');
    expect(c.registro).toBe('Itzi');
    expect(c.cobrado_con).toBe(
      'Transferencia → Scotiabank Pesos · Registró: Itzi · parte de esta fila (50 % de la venta del avión)',
    );
  });
});

describe('Balance GENERAL — «cómo se cobró» en los dos libros y en el consolidado', () => {
  it('multi-avión: cada libro lleva su fila con la parte y el consolidado hereda los campos', async () => {
    const { service, enviados } = armar(mundoCobros());
    await service.xlsxGeneral(DESDE, HASTA);
    const g = enviados.general as General;
    const esperado =
      'Transferencia → Scotiabank Pesos · Registró: Itzi · parte de esta fila (50 % de la venta del avión)';
    const porLibro = Object.fromEntries(
      g.aviones.map((p) => [
        p.matricula,
        filaDe(p.vuelos, V3).cobros.map((c) => c.cobrado_con),
      ]),
    );
    expect(porLibro).toEqual({
      'XB-DOS': [esperado],
      'XB-TST': [esperado],
    });
    const consolidadoV3 = g.consolidado.vuelos
      .filter((f) => f.vuelo_id === V3)
      .map((f) => f.cobros.map((c) => [c.metodo_etiqueta, c.cobrado_con]));
    expect(consolidadoV3).toEqual([
      [
        [
          'Transferencia · parte de esta fila (50 % de la venta del avión)',
          esperado,
        ],
      ],
      [
        [
          'Transferencia · parte de esta fila (50 % de la venta del avión)',
          esperado,
        ],
      ],
    ]);
    // El vuelo de un solo avión, igual que en el libro individual.
    const deV1 = filaDe(g.consolidado.vuelos, V1).cobros.map(
      (c) => c.cobrado_con,
    );
    expect(deV1).toEqual([
      'Transferencia → Scotiabank Pesos · Registró: Itzi',
      'Efectivo · Registró: Pablo Canales',
      'Transferencia → HSBC Dólares',
    ]);
  });
});

/**
 * El #503 multi-avión cobrado en DOS parcialidades, la primera con comisión
 * bancaria: $20,000 (comisión $630) + $16,000 = $36,000 al 50 %. Con UNA sola
 * parcialidad el ajuste del centavo (la última línea absorbe la diferencia
 * contra `cobrado_real_mxn`) escondía un `monto_mxn` sin la parte de la fila.
 */
function mundoMultiDosCobros(): Record<string, Fila[]> {
  const m = mundoCobros();
  return {
    ...m,
    cobro_vuelo: [
      ...m.cobro_vuelo.filter((c) => c.id !== 'c-4'),
      cobro('c-4', V3, {
        fecha: '2026-09-15T20:00:00+00:00',
        monto: 20000,
        tc_usd_mxn: 18,
        comision_banco_monto: 630,
        metodo_cobro: 'TRANSFERENCIA',
        cuenta_destino: 'Scotiabank Pesos',
        registrado_por: 'u-itzi',
        registro: { nombre: 'Itzi' },
      }),
      cobro('c-5', V3, {
        fecha: '2026-09-16T20:00:00+00:00',
        monto: 16000,
        tc_usd_mxn: 18,
        metodo_cobro: 'EFECTIVO',
        registrado_por: 'u-pablo',
        registro: { nombre: 'Pablo Canales' },
      }),
    ],
  };
}

/** Montos de las parcialidades de una fila: [monto_mxn, comision_mxn]. */
const montos = (cobros: BalanceAvionCobroPayload[]) =>
  cobros.map((c) => [c.monto_mxn, c.comision_mxn]);

describe('Balance — los NÚMEROS de cada parcialidad (revisión 6-oct-2026)', () => {
  it('multi-avión con dos parcialidades: cada una con la parte de ESTA fila, comisión incluida', async () => {
    const { service, enviados } = armar(mundoMultiDosCobros());
    await service.xlsx(AV, DESDE, HASTA);
    const p = enviados.individual!;
    expect(montos(filaDe(p.vuelos, V3).cobros)).toEqual([
      [10000, 315],
      [8000, null],
    ]);
    // 350 del #501 + 315 (la mitad de la comisión del #503).
    expect(p.totales.comision_banco_mxn).toBe(665);
  });

  it('general: cada libro lleva su mitad y Σ entre libros == el depósito real', async () => {
    const { service, enviados } = armar(mundoMultiDosCobros());
    await service.xlsxGeneral(DESDE, HASTA);
    const g = enviados.general as General;
    const porLibro = Object.fromEntries(
      g.aviones.map((p) => [p.matricula, montos(filaDe(p.vuelos, V3).cobros)]),
    );
    expect(porLibro).toEqual({
      'XB-DOS': [
        [10000, 315],
        [8000, null],
      ],
      'XB-TST': [
        [10000, 315],
        [8000, null],
      ],
    });
    const comisionPorLibro = Object.fromEntries(
      g.aviones.map((p) => [p.matricula, p.totales.comision_banco_mxn]),
    );
    expect(comisionPorLibro).toEqual({ 'XB-DOS': 315, 'XB-TST': 665 });
    // Comisión real del periodo: 350 + 630, sin contarla dos veces.
    expect(g.consolidado.totales.comision_banco_mxn).toBe(980);
  });
});

describe('Balance — el nombre de quien registró NUNCA tumba el libro (revisión 6-oct-2026)', () => {
  /** Los cobros del mundo SIN el embed (lo que PostgREST devuelve sin él). */
  function mundoSinEmbed(): Record<string, Fila[]> {
    const m = mundoCobros();
    return {
      ...m,
      cobro_vuelo: m.cobro_vuelo.map((c) => {
        const { registro: _registro, ...resto } = c;
        void _registro;
        return resto;
      }),
      usuario: [
        { id: 'u-itzi', nombre: 'Itzi' },
        { id: 'u-pablo', nombre: ' Pablo   Canales ' },
      ],
    };
  }

  const PGRST200: ErrorPostgrest = {
    code: 'PGRST200',
    message:
      "Could not find a relationship between 'cobro_vuelo' and 'usuario' in the schema cache",
  };
  const TIMEOUT: ErrorPostgrest = {
    code: '57014',
    message: 'canceling statement due to statement timeout',
  };

  afterEach(() => jest.restoreAllMocks());

  it('embed sin resolver: repite SIN él, lee los nombres en lote y el payload es IDÉNTICO', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const normal = armar(mundoCobros());
    await normal.service.xlsx(AV, DESDE, HASTA);
    const respaldo = armar(mundoSinEmbed(), { errorEmbed: PGRST200 });
    await respaldo.service.xlsx(AV, DESDE, HASTA);
    expect(respaldo.selectsCobro).toHaveLength(2);
    expect(respaldo.selectsCobro[0]).toContain(
      'registro:usuario!registrado_por(nombre)',
    );
    expect(respaldo.selectsCobro[1]).not.toContain('registro:');
    expect(respaldo.selectsCobro[1]).toContain('registrado_por');
    expect(sinSello(respaldo.enviados.individual!)).toEqual(
      sinSello(normal.enviados.individual!),
    );
    expect(
      filaDe(respaldo.enviados.individual!.vuelos, V1).cobros.map(
        (c) => c.cobrado_con,
      ),
    ).toEqual([
      'Transferencia → Scotiabank Pesos · Registró: Itzi',
      'Efectivo · Registró: Pablo Canales',
      'Transferencia → HSBC Dólares',
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no resolvió el embed'),
    );
  });

  it('embed sin resolver y sin nombres que resuelvan: los números salen igual y sin «Registró»', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const mundo = mundoSinEmbed();
    delete mundo.usuario;
    const { service, enviados } = armar(mundo, { errorEmbed: PGRST200 });
    await service.xlsx(AV, DESDE, HASTA);
    const fila = filaDe(enviados.individual!.vuelos, V1);
    expect(montos(fila.cobros)).toEqual([
      [20000, 350],
      [10000, null],
      [10000, null],
    ]);
    expect(fila.cobros.map((c) => c.registro)).toEqual([null, null, null]);
    expect(fila.cobros.map((c) => c.cobrado_con)).toEqual([
      'Transferencia → Scotiabank Pesos',
      'Efectivo',
      'Transferencia → HSBC Dólares',
    ]);
  });

  it('cualquier OTRO error de los cobros tumba el libro como siempre (sin reintentar)', async () => {
    const { service, selectsCobro } = armar(mundoCobros(), {
      errorEmbed: TIMEOUT,
    });
    await expect(service.xlsx(AV, DESDE, HASTA)).rejects.toThrow(
      'Balance XB-TST: fallo al leer cobros: canceling statement due to statement timeout',
    );
    expect(selectsCobro).toHaveLength(1);
  });

  it('si la consulta SIN el embed también falla, el libro se cae con ESE error', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, selectsCobro } = armar(mundoSinEmbed(), {
      errorEmbed: PGRST200,
      errorSinEmbed: TIMEOUT,
    });
    await expect(service.xlsx(AV, DESDE, HASTA)).rejects.toThrow(
      'fallo al leer cobros: canceling statement due to statement timeout',
    );
    expect(selectsCobro).toHaveLength(2);
  });
});
