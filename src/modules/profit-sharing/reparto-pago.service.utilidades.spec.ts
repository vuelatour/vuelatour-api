/**
 * COBRO DE UN VUELO CON UTILIDADES DEL SOCIO — el lado de la CUENTA DEL SOCIO
 * (23-nov-2026, API 0.0.148, invariante 143).
 *
 * `RepartoPagoService.prepararEntregaDeVuelo` valida la entrega con los
 * candados de «Pagos a socios» SIN insertarla (la inserta la BD junto con el
 * cobro del vuelo); una entrega que es el pago de un vuelo —existe un cobro
 * que la cita— no se corrige ni se da de baja desde la cuenta, y dice su
 * vuelo en la lista y en el concepto del estado de cuenta.
 *
 * Mundo de `reparto-cuenta.fixture-spec`: Mauricio (69 % de N4142R) tiene
 * $1,395.94 MXN por entregar de septiembre; hoy es 1-oct-2026 (Cancún).
 */
import { Rol } from '../../common/types/auth.types';
import {
  ALE,
  KEY,
  MAURICIO,
  N4142R,
  XBAJA,
  errorDe,
  mundo,
  pagoFila,
} from './reparto-cuenta.fixture-spec';
import { conceptoEntrega } from './reparto-cuenta.util';
import { aPagoSocio, type RepartoPagoRow } from './reparto-pago.util';

const DIRECCION = { userId: ALE, rol: Rol.DIRECCION };
const VUELO = 'ffffffff-0000-4000-8000-000000000498';
const COBRO = '99999999-0000-4000-8000-000000000001';
const ENTREGA = 'dddddddd-0000-4000-8000-000000000001';

/** Lo que manda `CobroUtilidadesService` para el vuelo #498. */
const DEL_VUELO = {
  socio_id: MAURICIO,
  aeronave_id: N4142R,
  monto: 1000,
  moneda: 'MXN',
  tc_usd_mxn: 18.5,
  fecha_pago: '2026-09-28',
  referencia: 'Vuelo #498',
  notas: '  lo pidió el socio ',
  client_request_id: KEY,
};

/** Fila de `cobro_vuelo` que cita la entrega (con el embed del vuelo). */
const cobroQueCita = (entregaId: string) => ({
  id: COBRO,
  vuelo_id: VUELO,
  reparto_pago_id: entregaId,
  vuelo: {
    folio: 498,
    fecha_vuelo: '2026-09-28T15:00:00.000Z',
    cliente: { nombre: 'Mauricio Roque' },
    aeronave: { matricula: 'N4142R' },
  },
});

describe('RepartoPagoService.prepararEntregaDeVuelo', () => {
  it('arma la fila de la entrega con las fuentes de siempre y NO escribe nada', async () => {
    const { pagos, tablas, escrituras } = mundo();
    const r = await pagos.prepararEntregaDeVuelo(DEL_VUELO, DIRECCION);
    expect(r).toEqual({
      fila: {
        socio_id: MAURICIO,
        aeronave_id: N4142R,
        // «Corresponde a» el avión elegido y al MES de la fecha del cobro.
        periodo: '2026-09-01',
        monto: 1000,
        moneda: 'MXN',
        tc_usd_mxn: 18.5,
        monto_usd: 54.05,
        monto_mxn: 1000,
        // Lo por entregar de meses cerrados ANTES de este cobro.
        saldo_snapshot_mxn: 1395.94,
        fecha_pago: '2026-09-28',
        // El CHECK de la tabla no cambió: la entrega de un vuelo es `OTRO`.
        metodo: 'OTRO',
        referencia: 'Vuelo #498',
        notas: 'lo pidió el socio',
        entregado_por: ALE,
        client_request_id: KEY,
        created_by: ALE,
      },
      monto_mxn: 1000,
      por_entregar_mxn: 1395.94,
      adelanto: false,
    });
    expect(tablas.reparto_pago).toEqual([]);
    expect(escrituras).toEqual([]);
  });

  it('en DÓLARES: los pesos salen del T.C. y `tc_usd_mxn` va null (CHECK de la tabla)', async () => {
    const { pagos } = mundo();
    const r = await pagos.prepararEntregaDeVuelo(
      { ...DEL_VUELO, monto: 50, moneda: 'USD' },
      DIRECCION,
    );
    expect(r.fila).toMatchObject({
      monto: 50,
      moneda: 'USD',
      tc_usd_mxn: null,
      monto_usd: 50,
      monto_mxn: 925,
    });
    expect(r.monto_mxn).toBe(925);
  });

  it('rebasa lo por entregar de meses cerrados ⇒ 409 PAGO_EXCEDE_SALDO (el mismo del adelanto); con aceptar_exceso pasa y lo dice', async () => {
    const { pagos, tablas } = mundo();
    const caro = { ...DEL_VUELO, monto: 44174.3 };
    const e = await errorDe(pagos.prepararEntregaDeVuelo(caro, DIRECCION));
    expect(e.status).toBe(409);
    expect(e.code).toBe('PAGO_EXCEDE_SALDO');
    expect(e.details).toMatchObject({
      por_entregar_mxn: 1395.94,
      monto_mxn: 44174.3,
      exceso_mxn: 42778.36,
      saldo_despues_mxn: -42778.36,
    });
    const ok = await pagos.prepararEntregaDeVuelo(
      { ...caro, aceptar_exceso: true },
      DIRECCION,
    );
    expect(ok.adelanto).toBe(true);
    expect(ok.fila.saldo_snapshot_mxn).toBe(1395.94);
    expect(tablas.reparto_pago).toEqual([]);
  });

  it('los candados de una entrega: socio que no es de ESE avión, T.C. ausente o fuera de banda, monto inválido y fecha futura ⇒ 400 con su code', async () => {
    const { pagos } = mundo();
    const casos: Array<[Partial<typeof DEL_VUELO>, string]> = [
      // XA-OLD: Mauricio nunca fue socio de ese avión (de N990GG sí lo fue).
      [{ aeronave_id: XBAJA }, 'SOCIO_NO_ES_DE_LA_AERONAVE'],
      [{ socio_id: ALE }, 'SOCIO_INVALIDO'],
      [{ tc_usd_mxn: 40 }, 'TC_FUERA_DE_RANGO'],
      [{ monto: 0 }, 'MONTO_INVALIDO'],
      [{ monto: 10.123 }, 'MONTO_INVALIDO'],
      [{ fecha_pago: '2026-10-02' }, 'FECHA_PAGO_FUTURA'],
    ];
    for (const [cambio, code] of casos) {
      const e = await errorDe(
        pagos.prepararEntregaDeVuelo({ ...DEL_VUELO, ...cambio }, DIRECCION),
      );
      expect([cambio, e.status, e.code]).toEqual([cambio, 400, code]);
    }
    const sinTc = await errorDe(
      pagos.prepararEntregaDeVuelo(
        { ...DEL_VUELO, tc_usd_mxn: null },
        DIRECCION,
      ),
    );
    expect([sinTc.status, sinTc.code]).toEqual([400, 'TC_REQUERIDO']);
    const sinFecha = await errorDe(
      pagos.prepararEntregaDeVuelo(
        { ...DEL_VUELO, fecha_pago: null },
        DIRECCION,
      ),
    );
    expect([sinFecha.status, sinFecha.code]).toEqual([
      400,
      'FECHA_PAGO_INVALIDA',
    ]);
  });

  it('sin la cuenta corriente (migración 20261002000001) ⇒ 503, como cualquier entrega', async () => {
    const { pagos } = mundo({ sinMigracion: true });
    const e = await errorDe(pagos.prepararEntregaDeVuelo(DEL_VUELO, DIRECCION));
    expect([e.status, e.code]).toEqual([503, 'CUENTA_SOCIO_NO_DISPONIBLE']);
  });
});

describe('RepartoPagoService — la entrega que es el pago de un vuelo', () => {
  /** La entrega del vuelo #498 ya insertada (por la BD) y el cobro que la cita. */
  const conEntregaDeVuelo = () => {
    const m = mundo({
      pagos: [
        pagoFila({
          id: ENTREGA,
          metodo: 'OTRO',
          referencia: 'Vuelo #498',
          fecha_pago: '2026-09-28',
        }),
      ],
    });
    m.tablas.cobro_vuelo = [cobroQueCita(ENTREGA)];
    return m;
  };

  it('despuesDeVuelo: la entrega con su VUELO y la cuenta ya recalculada', async () => {
    const { pagos } = conEntregaDeVuelo();
    const r = await pagos.despuesDeVuelo(MAURICIO, ENTREGA);
    expect(r.pago).toMatchObject({
      id: ENTREGA,
      metodo: 'OTRO',
      monto_mxn: 1000,
      aeronave: { id: N4142R, matricula: 'N4142R' },
      vuelo: {
        id: VUELO,
        folio: 498,
        cobro_id: COBRO,
        fecha: '2026-09-28',
        cliente: 'Mauricio Roque',
        matricula: 'N4142R',
      },
    });
    // 1,395.94 de septiembre − 1,000 del vuelo.
    expect(r.cuenta.entregado_mxn).toBe(1000);
    expect(r.cuenta.por_entregar_cerrado_mxn).toBe(395.94);
  });

  it('corregir su dinero, fecha, método, avión o mes ⇒ 409 ENTREGA_DE_VUELO (se quita desde el vuelo); nada se escribe', async () => {
    const { pagos, tablas, escrituras } = conEntregaDeVuelo();
    const cambios: Array<Record<string, unknown>> = [
      { monto: 500 },
      { moneda: 'USD', tc_usd_mxn: 18.5 },
      { tc_usd_mxn: 19 },
      { fecha_pago: '2026-09-30' },
      { metodo: 'EFECTIVO' },
      { aeronave_id: null },
      { mes: '2026-08' },
      { entregado_por_id: ALE },
    ];
    for (const cambio of cambios) {
      const e = await errorDe(pagos.actualizar(ENTREGA, cambio, DIRECCION));
      expect([cambio, e.status, e.code]).toEqual([
        cambio,
        409,
        'ENTREGA_DE_VUELO',
      ]);
      expect(e.details).toEqual({
        vuelo_id: VUELO,
        folio: 498,
        cobro_id: COBRO,
      });
      expect(e.message).toContain('vuelo #498');
    }
    expect(escrituras).toEqual([]);
    expect(tablas.reparto_pago[0]).toMatchObject({ monto: 1000 });
  });

  it('lo que no es dinero sí se corrige (notas, quién recibió, folio de factura)', async () => {
    const { pagos, tablas } = conEntregaDeVuelo();
    const r = await pagos.actualizar(
      ENTREGA,
      { notas: 'Autorizó Ale', recibido_por: 'El socio' },
      DIRECCION,
    );
    expect(r.pago).toMatchObject({
      notas: 'Autorizó Ale',
      vuelo: { folio: 498 },
    });
    expect(tablas.reparto_pago[0]).toMatchObject({
      notas: 'Autorizó Ale',
      recibido_por: 'El socio',
      monto: 1000,
    });
  });

  it('darla de baja desde «Pagos a socios» ⇒ 409 ENTREGA_DE_VUELO; sigue viva', async () => {
    const { pagos, tablas } = conEntregaDeVuelo();
    const e = await errorDe(
      pagos.eliminar(ENTREGA, 'Se capturó por error', DIRECCION),
    );
    expect([e.status, e.code]).toEqual([409, 'ENTREGA_DE_VUELO']);
    expect(tablas.reparto_pago[0].deleted_at).toBeNull();
  });

  it('ya sin cobro que la cite (se quitó en el vuelo y algo falló a la mitad) vuelve a ser una entrega normal: se puede dar de baja', async () => {
    const { pagos, tablas } = conEntregaDeVuelo();
    tablas.cobro_vuelo = [];
    const r = await pagos.eliminar(
      ENTREGA,
      'Se quitó el cobro del vuelo',
      DIRECCION,
    );
    expect(r.deleted).toBe(true);
    expect(tablas.reparto_pago[0].deleted_at).not.toBeNull();
  });

  it('una entrega NORMAL no pregunta por vuelos al corregir notas ni se ve afectada', async () => {
    const m = mundo({ pagos: [pagoFila({ id: ENTREGA })] });
    const r = await m.pagos.actualizar(ENTREGA, { monto: 900 }, DIRECCION);
    expect(r.pago.monto_mxn).toBe(900);
    expect(r.pago).not.toHaveProperty('vuelo');
  });

  it('la lista de entregas y el estado de cuenta dicen el vuelo; el concepto no dice «Otro»', async () => {
    const { pagos, cuentas } = conEntregaDeVuelo();
    const lista = await pagos.listar({}, DIRECCION);
    expect(lista.pagos).toHaveLength(1);
    expect(lista.pagos[0].vuelo).toMatchObject({ id: VUELO, folio: 498 });
    const estado = await cuentas.estadoDeCuenta(MAURICIO, {}, DIRECCION);
    const movimientos = (
      estado as unknown as {
        movimientos: Array<{
          tipo: string;
          concepto: string;
          pago?: { vuelo?: unknown } | null;
        }>;
      }
    ).movimientos;
    const entrega = movimientos.find((x) => x.tipo === 'ENTREGA');
    expect(entrega?.concepto).toBe(
      'Vuelo #498 pagado con utilidades · $1,000 MXN a T.C. 18.5 · corresponde a sep 2026 · N4142R',
    );
    expect(entrega?.pago?.vuelo).toMatchObject({ folio: 498 });
  });
});

describe('aPagoSocio / conceptoEntrega con y sin vuelo', () => {
  const fila = pagoFila({
    id: ENTREGA,
    metodo: 'OTRO',
  }) as unknown as RepartoPagoRow;

  it('`vuelo` SOLO viaja en las entregas de un vuelo (una entrega normal no gana la llave)', () => {
    expect(aPagoSocio(fila)).not.toHaveProperty('vuelo');
    const vuelos = new Map([
      [
        ENTREGA,
        {
          id: VUELO,
          folio: 498,
          cobro_id: COBRO,
          fecha: '2026-09-28',
          cliente: null,
          matricula: 'N621TX',
        },
      ],
    ]);
    expect(
      aPagoSocio(fila, new Map(), new Map(), new Map(), vuelos).vuelo,
    ).toEqual(vuelos.get(ENTREGA));
  });

  it('concepto de una entrega `OTRO` normal: el de siempre («Otro», con su referencia)', () => {
    expect(
      conceptoEntrega({
        mes: '2026-09',
        metodo: 'OTRO',
        moneda: 'MXN',
        monto: 1000,
        tc_usd_mxn: 18.5,
        referencia: 'Vuelo #498',
        aeronave: { id: N4142R, matricula: 'N4142R' },
      }),
    ).toBe(
      'Entrega · Otro · $1,000 MXN a T.C. 18.5 · ref Vuelo #498 · corresponde a sep 2026 · N4142R',
    );
  });

  it('concepto del pago de un vuelo sin folio conocido: «Vuelo pagado con utilidades»', () => {
    expect(
      conceptoEntrega({
        mes: '2026-09',
        metodo: 'OTRO',
        moneda: 'USD',
        monto: 50,
        monto_mxn: 925,
        tc_usd_mxn: null,
        referencia: 'Vuelo #498',
        aeronave: null,
        vuelo: {
          id: VUELO,
          folio: null,
          cobro_id: COBRO,
          fecha: null,
          cliente: null,
          matricula: null,
        },
      }),
    ).toBe(
      'Vuelo pagado con utilidades · $50 USD = $925 MXN · corresponde a sep 2026',
    );
  });
});
