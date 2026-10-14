import {
  aCargoDeGasto,
  alertasConciliacionGasto,
  LIGAS_REGISTRADAS_DESDE,
  motivoSinArchivo,
  ordenarCargosDeGasto,
  registroDeParte,
  type CargoDeGastoDetalle,
  type VistaConciliacionGasto,
} from './cargos-de-gasto.util';
import { lineaNotaCargo } from '../../common/vinculo-no-bancario.util';

/**
 * CONCILIACIÓN AL REVÉS (13-oct-2026, invariante 71): el modelo puro de «el
 * cargo, la cuenta y el estado de cuenta de un gasto», con filas REALES de
 * prod del 13-oct (lote VIP SAESA #345, EJE SCOTIA con 0.02, cruzado
 * 913a7d19, sin archivo 20abe352, Paywise cdfbf491).
 */
type Row = Record<string, unknown>;

const G345 = '4e29c476-a956-440f-bd83-2c70f78279d4';

const EJE = {
  id: '212add6c-c4e5-44cc-a30c-0635c0ab3036',
  alias: 'EJE SCOTIA',
  banco: 'Scotiabank',
  moneda: 'MXN',
  tipo: 'BANCO',
  // Lo que NUNCA debe salir aunque la fila cruda lo traiga.
  numero_cuenta: '0123456789',
  clabe: '044180001234567890',
};

const ARCHIVO_EJE = {
  id: '1758cc58-7d78-4f73-966b-e7867803b8cc',
  filename: 'scotia eje sep.pdf',
  formato: 'pdf',
  movimientos_importados: 98,
  created_at: '2026-10-06T15:22:46.413405+00:00',
  storage_path: 'estados-cuenta/2026/10/scotia-eje-sep.pdf',
  importo: { nombre: 'Alejandro Canales' },
};

/** Cargo SAESA #345: 11,205.60 = 4 × 2,801.40 (lote, diferencia 0). */
const movSaesa = (extra: Row = {}): Row => ({
  id: '73a8d809-6468-4554-add4-f874a0c4ed9c',
  cuenta_bancaria_id: EJE.id,
  fecha: '2026-09-30',
  tipo: 'CARGO',
  monto: -11205.6,
  descripcion: 'SEL TRANSF. INTERBANCARIA SPEI',
  referencia: '00000000000000000001',
  conciliado: true,
  gasto_id: null,
  origen: 'IMPORTADO',
  notas: null,
  created_at: '2026-10-06T15:22:46.58996+00:00',
  estado_cuenta_id: ARCHIVO_EJE.id,
  storage_path: 'no-debe-salir',
  cuenta: EJE,
  estado_cuenta: ARCHIVO_EJE,
  creo: { nombre: 'Alejandro Canales' },
  gastos_n: 4,
  gastos: [
    { id: '4cee0dfe-dcb9-41c5-98c6-1be19d147c1a', monto_parte: 2801.4 },
    { id: G345, monto_parte: 2801.4 },
    { id: '5329b2dd-8649-46c6-80c9-a360803a4dea', monto_parte: 2801.4 },
    { id: 'f58868a3-bc96-4fb6-9b86-4b93ea096352', monto_parte: 2801.4 },
  ],
  gastos_suma: 11205.6,
  gastos_diferencia: 0,
  ...extra,
});

const parteSaesa = {
  movimiento_id: '73a8d809-6468-4554-add4-f874a0c4ed9c',
  monto_parte: 2801.4,
  moneda: 'MXN',
  created_at: '2026-10-13T21:43:29.382119+00:00',
  ligada_por: 'Diego Ramírez',
};

const GASTO_MXN = { id: G345, moneda: 'MXN' };

const llavesProhibidas = (x: unknown): string[] => {
  const s = JSON.stringify(x);
  return ['storage_path', 'numero_cuenta', 'clabe'].filter((k) =>
    s.includes(`"${k}"`),
  );
};

describe('motivoSinArchivo', () => {
  it('por origen y por archivo', () => {
    expect(
      motivoSinArchivo({ estado_cuenta_id: null, origen: 'IMPORTADO' }),
    ).toBe('IMPORTADO_SIN_ARCHIVO');
    expect(motivoSinArchivo({ estado_cuenta_id: null, origen: 'MANUAL' })).toBe(
      'CAPTURA_MANUAL',
    );
    expect(
      motivoSinArchivo({ estado_cuenta_id: ARCHIVO_EJE.id, origen: 'MANUAL' }),
    ).toBeNull();
    // Origen desconocido: jamás «capturado a mano».
    expect(motivoSinArchivo({ origen: 'OTRO' })).toBe('IMPORTADO_SIN_ARCHIVO');
    expect(motivoSinArchivo({})).toBe('IMPORTADO_SIN_ARCHIVO');
  });
});

describe('registroDeParte — corte del backfill (2-oct-2026 00:00 Cancún)', () => {
  it('el corte es 2026-10-02T05:00:00.000Z', () => {
    expect(LIGAS_REGISTRADAS_DESDE).toBe('2026-10-02T05:00:00.000Z');
  });

  it('antes del corte ⇒ null; desde el corte ⇒ {por, at}', () => {
    expect(registroDeParte({ created_at: '2026-10-01T22:54:57Z' })).toBeNull();
    expect(registroDeParte({ created_at: '2026-10-02T04:59:59Z' })).toBeNull();
    expect(registroDeParte({ created_at: '2026-10-02T05:00:00Z' })).toEqual({
      por: null,
      at: '2026-10-02T05:00:00Z',
    });
    expect(
      registroDeParte({
        created_at: '2026-10-13T21:43:29Z',
        ligada_por: 'Diego Ramírez',
      }),
    ).toEqual({ por: 'Diego Ramírez', at: '2026-10-13T21:43:29Z' });
  });

  it('null o ilegible ⇒ null', () => {
    expect(registroDeParte({ created_at: null })).toBeNull();
    expect(registroDeParte({ created_at: 'ayer' })).toBeNull();
  });
});

describe('aCargoDeGasto — filas reales de prod', () => {
  it('lote SAESA (#345): el lote llega TAL CUAL de anotarPartes, con registro', () => {
    const c = aCargoDeGasto({
      parte: parteSaesa,
      mov: movSaesa(),
      gasto: GASTO_MXN,
    });
    expect(c).toMatchObject({
      movimiento_id: '73a8d809-6468-4554-add4-f874a0c4ed9c',
      fecha: '2026-09-30',
      tipo: 'CARGO',
      monto: 11205.6,
      moneda: 'MXN',
      descripcion: 'SEL TRANSF. INTERBANCARIA SPEI',
      referencia: '00000000000000000001',
      conciliado: true,
      origen: 'IMPORTADO',
      creado_at: '2026-10-06T15:22:46.58996+00:00',
      creado_por: 'Alejandro Canales',
      orden_archivo: null,
      cuenta: {
        id: EJE.id,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
      estado_cuenta: {
        id: ARCHIVO_EJE.id,
        filename: 'scotia eje sep.pdf',
        formato: 'pdf',
        importado_at: '2026-10-06T15:22:46.413405+00:00',
        importado_por: 'Alejandro Canales',
        movimientos_importados: 98,
      },
      sin_archivo: null,
      parte: {
        monto_parte: 2801.4,
        moneda: 'MXN',
        cruzada: false,
        registro: {
          por: 'Diego Ramírez',
          at: '2026-10-13T21:43:29.382119+00:00',
        },
      },
      justificacion: null,
      notas_oficina: null,
    });
    expect(c.lote).toEqual({
      gastos_n: 4,
      gastos: movSaesa().gastos,
      gastos_suma: 11205.6,
      gastos_diferencia: 0,
    });
    expect(llavesProhibidas(c)).toEqual([]);
    expect(c.cuenta).not.toHaveProperty('numero_cuenta');
    expect(c.estado_cuenta).not.toHaveProperty('storage_path');
  });

  it('1 ↔ 1: sin lote', () => {
    const c = aCargoDeGasto({
      parte: { ...parteSaesa, monto_parte: 2231.38 },
      mov: movSaesa({
        monto: -2231.38,
        gastos_n: 1,
        gastos: [{ id: G345 }],
        gastos_suma: 2231.38,
        gastos_diferencia: 0,
      }),
      gasto: GASTO_MXN,
    });
    expect(c.lote).toBeNull();
    expect(c.monto).toBe(2231.38);
  });

  it('lote EJE SCOTIA de 6,694.13: la diferencia 0.02 viaja intacta y la parte no se ajusta', () => {
    const c = aCargoDeGasto({
      parte: { ...parteSaesa, monto_parte: 2231.37 },
      mov: movSaesa({
        id: '165c7783-f5df-44e3-899b-d1af4713cfd4',
        monto: -6694.13,
        gastos_n: 3,
        gastos: [],
        gastos_suma: 6694.11,
        gastos_diferencia: 0.02,
      }),
      gasto: GASTO_MXN,
    });
    expect(c.lote).toMatchObject({
      gastos_n: 3,
      gastos_suma: 6694.11,
      gastos_diferencia: 0.02,
    });
    expect(c.parte.monto_parte).toBe(2231.37);
  });

  it('cruzado (913a7d19: parte en MXN, gasto en USD) ⇒ cruzada true', () => {
    const c = aCargoDeGasto({
      parte: {
        movimiento_id: 'bf543597-31f2-4624-bec9-a28e362d4825',
        monto_parte: 12451.49,
        moneda: 'MXN',
        created_at: '2026-10-02T00:00:00Z',
      },
      mov: movSaesa({
        id: 'bf543597-31f2-4624-bec9-a28e362d4825',
        monto: -12451.49,
        descripcion: 'AIRCRAFT SPRUCE AND SP',
        gastos_n: 1,
      }),
      gasto: { id: '913a7d19-6a35-42c8-8494-65597d07f300', moneda: 'USD' },
    });
    expect(c.parte).toEqual({
      monto_parte: 12451.49,
      moneda: 'MXN',
      cruzada: true,
      // Parte del backfill: sin registro.
      registro: null,
    });
  });

  it('espejo (parte SINTÉTICA sin created_at) ⇒ registro null', () => {
    const c = aCargoDeGasto({
      parte: {
        movimiento_id: '73a8d809-6468-4554-add4-f874a0c4ed9c',
        monto_parte: 11205.6,
        moneda: 'MXN',
        created_at: null,
      },
      mov: movSaesa({ gastos_n: undefined, gastos: undefined }),
      gasto: GASTO_MXN,
    });
    expect(c.parte.registro).toBeNull();
    expect(c.lote).toBeNull();
  });

  it('sin archivo (20abe352: importado el 16-jul-2026 por Jimmy Chi)', () => {
    const c = aCargoDeGasto({
      parte: {
        movimiento_id: '3013be8a-72bb-4de4-ab8e-e106b563a42e',
        monto_parte: 317.39,
        moneda: 'MXN',
        created_at: '2026-10-02T00:00:00Z',
      },
      mov: movSaesa({
        id: '3013be8a-72bb-4de4-ab8e-e106b563a42e',
        fecha: '2026-07-01',
        monto: -317.39,
        descripcion: 'Aeropuerto de Cozumel',
        estado_cuenta_id: null,
        estado_cuenta: null,
        origen: 'IMPORTADO',
        created_at: '2026-07-17T00:34:09.441194+00:00',
        creo: [{ nombre: 'Jimmy Chi' }],
        gastos_n: 1,
      }),
      gasto: { id: '20abe352-c924-4e9a-8769-b965a6d63ec6', moneda: 'MXN' },
    });
    expect(c).toMatchObject({
      estado_cuenta: null,
      sin_archivo: 'IMPORTADO_SIN_ARCHIVO',
      creado_at: '2026-07-17T00:34:09.441194+00:00',
      creado_por: 'Jimmy Chi',
    });
  });

  it('pasarela (Paywise) ⇒ cuenta.tipo PASARELA', () => {
    const c = aCargoDeGasto({
      parte: { ...parteSaesa, monto_parte: 7500 },
      mov: movSaesa({
        monto: -7500,
        descripcion: 'itzy 2da sep',
        cuenta: [
          {
            id: 'cta-paywise',
            alias: 'Paywise',
            banco: 'Paywise',
            moneda: 'MXN',
            tipo: 'PASARELA',
          },
        ],
        gastos_n: 1,
      }),
      gasto: { id: 'cdfbf491-e326-43b7-b182-b7a05f81ed76', moneda: 'MXN' },
    });
    expect(c.cuenta).toEqual({
      id: 'cta-paywise',
      alias: 'Paywise',
      banco: 'Paywise',
      moneda: 'MXN',
      tipo: 'PASARELA',
    });
  });

  it('notas con la línea de OTRO gasto + texto de la oficina ⇒ sin justificación y la oficina byte a byte', () => {
    const otraLinea = lineaNotaCargo(
      {
        id: 'a1b2c3d4-0e0f-4a1b-8c2d-3e4f5a6b7c8d',
        fecha_gasto: '2026-09-27',
        monto: 212,
        moneda: 'MXN',
        medio_pago: 'EFECTIVO',
        categoria: 'TAXI',
        vuelo_folio: 330,
      },
      {
        justificacion: 'Ticket facturado por Mari',
        usuario: 'Mari',
        hoy: '2026-10-06',
      },
    );
    const oficina = 'Revisar con Jimmy  \r\n  (segunda línea de la oficina)';
    const c = aCargoDeGasto({
      parte: parteSaesa,
      mov: movSaesa({ notas: `${oficina}\r\n\r\n${otraLinea}`, gastos_n: 1 }),
      gasto: GASTO_MXN,
    });
    expect(c.justificacion).toBeNull();
    expect(c.notas_oficina).toBe(oficina);
  });

  it('la línea de ESTE gasto ⇒ justificación (efectivo ligado)', () => {
    const linea = lineaNotaCargo(
      {
        id: G345,
        fecha_gasto: '2026-09-28',
        monto: 212,
        moneda: 'MXN',
        medio_pago: 'EFECTIVO',
        categoria: 'TAXI',
        vuelo_folio: 330,
      },
      {
        justificacion: 'Mari lo facturó para no perder la deducción',
        usuario: 'Mary Cruz',
        hoy: '2026-10-06',
      },
    );
    const c = aCargoDeGasto({
      parte: parteSaesa,
      mov: movSaesa({ notas: linea, gastos_n: 1 }),
      gasto: GASTO_MXN,
    });
    expect(c.justificacion).toEqual({
      linea,
      medio: 'EFECTIVO',
      razon: 'Mari lo facturó para no perder la deducción',
      firmante: 'Mary Cruz',
      fecha: '06-oct-2026',
    });
    expect(c.notas_oficina).toBeNull();
  });

  it('orden_archivo: número o null', () => {
    const c = aCargoDeGasto({
      parte: parteSaesa,
      mov: movSaesa({ orden_archivo: 37, gastos_n: 1 }),
      gasto: GASTO_MXN,
    });
    expect(c.orden_archivo).toBe(37);
  });
});

describe('ordenarCargosDeGasto', () => {
  const c = (id: string, fecha: string) =>
    ({ movimiento_id: id, fecha }) as CargoDeGastoDetalle;

  it('por fecha y, con la misma fecha, por id (copia)', () => {
    const entrada = [
      c('d7259736', '2026-09-07'),
      c('5f7ce959', '2026-09-07'),
      c('aaa', '2026-08-01'),
    ];
    const out = ordenarCargosDeGasto(entrada);
    expect(out.map((x) => x.movimiento_id)).toEqual([
      'aaa',
      '5f7ce959',
      'd7259736',
    ]);
    expect(entrada[0].movimiento_id).toBe('d7259736');
  });
});

describe('alertasConciliacionGasto — solo hechos guardados', () => {
  const vista = (extra: Partial<VistaConciliacionGasto> = {}) => ({
    n_partes: 1,
    cruzado: false,
    suma: 2801.4,
    monto_vinculado: 2801.4,
    faltante: 0,
    cubierto: true,
    ...extra,
  });
  const cargo = (
    extra: Partial<CargoDeGastoDetalle> = {},
  ): CargoDeGastoDetalle => ({
    ...aCargoDeGasto({
      parte: parteSaesa,
      mov: movSaesa({ gastos_n: 1 }),
      gasto: GASTO_MXN,
    }),
    ...extra,
  });
  const lote = aCargoDeGasto({
    parte: parteSaesa,
    mov: movSaesa(),
    gasto: GASTO_MXN,
  });

  it('CONCILIADO_SIN_CARGOS', () => {
    expect(
      alertasConciliacionGasto({
        conciliado: true,
        vista: vista({ n_partes: 0, suma: 0, monto_vinculado: 0 }),
        cargos: [],
        tcGasto: null,
      }),
    ).toEqual(['CONCILIADO_SIN_CARGOS']);
  });

  it('ESTADO_DESFASADO (conciliado ≠ cubierto de la vista, con partes)', () => {
    expect(
      alertasConciliacionGasto({
        conciliado: false,
        vista: vista(),
        cargos: [cargo()],
        tcGasto: null,
      }),
    ).toEqual(['ESTADO_DESFASADO']);
  });

  it('TC_NO_REGISTRADO (parte cruzada sin tc_gasto)', () => {
    const cruzado = cargo({
      parte: { ...cargo().parte, cruzada: true, moneda: 'MXN' },
    });
    expect(
      alertasConciliacionGasto({
        conciliado: true,
        vista: vista({ cruzado: true, suma: 0 }),
        cargos: [cruzado],
        tcGasto: null,
      }),
    ).toEqual(['TC_NO_REGISTRADO']);
    // Con T.C. guardado: ninguna.
    expect(
      alertasConciliacionGasto({
        conciliado: true,
        vista: vista({ cruzado: true, suma: 0 }),
        cargos: [cruzado],
        tcGasto: 17.2244,
      }),
    ).toEqual([]);
  });

  it('LOTE_SIN_DETALLE (gastos del lote no leídos)', () => {
    const sinDetalle = cargo({ lote: { ...lote.lote!, gastos: null } });
    expect(
      alertasConciliacionGasto({
        conciliado: true,
        vista: vista(),
        cargos: [sinDetalle],
        tcGasto: null,
      }),
    ).toEqual(['LOTE_SIN_DETALLE']);
  });

  it('casos normales ⇒ []', () => {
    const normales: Array<Parameters<typeof alertasConciliacionGasto>[0]> = [
      // 1 ↔ 1
      { conciliado: true, vista: vista(), cargos: [cargo()], tcGasto: null },
      // lote
      { conciliado: true, vista: vista(), cargos: [lote], tcGasto: null },
      // dos cargos
      {
        conciliado: true,
        vista: vista({ n_partes: 2, suma: 136.99, monto_vinculado: 136.99 }),
        cargos: [cargo(), cargo({ movimiento_id: 'otro' })],
        tcGasto: null,
      },
      // pasarela
      {
        conciliado: true,
        vista: vista(),
        cargos: [
          cargo({
            cuenta: {
              id: 'p',
              alias: 'Paywise',
              banco: 'Paywise',
              moneda: 'MXN',
              tipo: 'PASARELA',
            },
          }),
        ],
        tcGasto: null,
      },
      // efectivo justificado
      {
        conciliado: true,
        vista: vista(),
        cargos: [
          cargo({
            justificacion: {
              linea: 'x',
              medio: 'EFECTIVO',
              razon: 'r',
              firmante: 'Mary Cruz',
              fecha: '06-oct-2026',
            },
          }),
        ],
        tcGasto: null,
      },
      // sin conciliar (sin partes)
      {
        conciliado: false,
        vista: vista({
          n_partes: 0,
          suma: 0,
          monto_vinculado: 0,
          faltante: 8939.38,
          cubierto: false,
        }),
        cargos: [],
        tcGasto: null,
      },
      // sin la vista (espejo)
      { conciliado: true, vista: null, cargos: [cargo()], tcGasto: null },
    ];
    for (const caso of normales) {
      expect(alertasConciliacionGasto(caso)).toEqual([]);
    }
  });
});
