/**
 * `CobroUtilidadesService` (23-nov-2026, API 0.0.148, invariante 143): el
 * ORQUESTADOR de «el socio paga su vuelo con sus utilidades». No tiene reglas
 * de dinero propias; se congela que:
 *  - la idempotencia va PRIMERO (el reintento no rebota en ningún candado);
 *  - la entrega se PREPARA (candados de «Pagos a socios») antes de llamar al
 *    cobro, y si no pasa NO se escribe nada;
 *  - al cobro le llega la fila de la entrega por la opción interna (una sola
 *    escritura atómica), método `OTRO`, la MISMA llave y el MISMO T.C.;
 *  - el mes de utilidades = el mes (día de Cancún) de `fecha_cobro`.
 */
import { ConflictException } from '@nestjs/common';
import { Rol } from '../../common/types/auth.types';
import type { SupabaseService } from '../supabase/supabase.service';
import { CobroUtilidadesService } from './cobro-utilidades.service';
import type { CobroConUtilidadesDto } from './dto/cobro-utilidades.dto';
import type { RepartoPagoService } from './reparto-pago.service';

const VUELO = 'v-498';
const SOCIO = 's-macedo';
const AVION = 'a-n621tx';
const KEY = 'eeeeeeee-0000-4000-8000-000000000498';
const ACTOR = { userId: 'u-ale', rol: Rol.DIRECCION };
const FILA = { socio_id: SOCIO, metodo: 'OTRO', monto: 44174.3 };

type Fila = Record<string, unknown>;

/** El argumento `j` de la llamada `i` de un mock, sin `any`. */
const arg = (fn: jest.Mock, i: number, j: number): Fila =>
  (fn.mock.calls as unknown[][])[i][j] as Fila;

/** `cobro_vuelo` en memoria con lo justo: la sonda, la llave y la liga. */
function fakeSb(cobros: Fila[], opts: { sinColumna?: boolean } = {}) {
  const lecturas: string[] = [];
  const from = (tabla: string) => {
    const filtros: Array<(f: Fila) => boolean> = [];
    let sel = '';
    const ejecutar = () => {
      lecturas.push(`${tabla}:${sel}`);
      if (opts.sinColumna && sel.includes('reparto_pago_id')) {
        return {
          data: null,
          error: {
            code: '42703',
            message: 'column cobro_vuelo.reparto_pago_id does not exist',
          },
        };
      }
      return {
        data: cobros.filter((f) => filtros.every((fn) => fn(f))),
        error: null,
      };
    };
    const q = {
      select: (c: string) => {
        sel = c;
        return q;
      },
      eq: (col: string, v: unknown) => {
        filtros.push((f) => f[col] === v);
        return q;
      },
      limit: () => q,
      maybeSingle: () => {
        const r = ejecutar();
        return Promise.resolve({
          data: (r.data ?? [])[0] ?? null,
          error: r.error,
        });
      },
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve(ejecutar()).then(ok),
    };
    return q;
  };
  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    lecturas,
  };
}

function armar(
  opts: {
    cobros?: Fila[];
    sinColumna?: boolean;
    vuelo?: Fila;
  } = {},
) {
  const cobros = opts.cobros ?? [];
  const { supabase } = fakeSb(cobros, opts);
  const prepararEntregaDeVuelo = jest.fn().mockResolvedValue({
    fila: FILA,
    monto_mxn: 44174.3,
    por_entregar_mxn: 81181.23,
    adelanto: false,
  });
  const despuesDeVuelo = jest.fn().mockResolvedValue({
    pago: { id: 'e-1', vuelo: { folio: 498 } },
    cuenta: { por_entregar_mxn: 37006.93 },
  });
  const findById = jest
    .fn()
    .mockResolvedValue(
      opts.vuelo ?? { id: VUELO, folio: 498, tc_usd_mxn: 18.6673 },
    );
  const createCobro = jest
    .fn()
    .mockImplementation((vueloId: string, dto: Fila) => {
      const fila = {
        id: 'c-1',
        vuelo_id: vueloId,
        client_request_id: dto.client_request_id,
        reparto_pago_id: 'e-1',
        monto: dto.monto,
      };
      cobros.push(fila);
      return Promise.resolve(fila);
    });
  const svc = new CobroUtilidadesService(
    supabase,
    { prepararEntregaDeVuelo, despuesDeVuelo } as unknown as RepartoPagoService,
    { findById, createCobro },
  );
  jest
    .spyOn(svc, 'ahora')
    .mockReturnValue(new Date('2026-11-23T18:00:00.000Z'));
  return { svc, prepararEntregaDeVuelo, despuesDeVuelo, findById, createCobro };
}

const dto = (
  extra: Partial<CobroConUtilidadesDto> = {},
): CobroConUtilidadesDto => ({
  socio_id: SOCIO,
  aeronave_id: AVION,
  monto: 44174.3,
  moneda: 'MXN',
  tc_usd_mxn: 18.6673,
  fecha_cobro: new Date('2026-10-28T17:00:00.000Z'),
  client_request_id: KEY,
  ...extra,
});

describe('CobroUtilidadesService.registrar', () => {
  it('prepara la entrega y la manda con el cobro en UNA escritura: método OTRO, misma llave, mismo T.C., mes = el de la fecha', async () => {
    const m = armar();
    const r = await m.svc.registrar(VUELO, dto({ notas: 'lo pidió' }), ACTOR);
    expect(m.prepararEntregaDeVuelo).toHaveBeenCalledWith(
      {
        socio_id: SOCIO,
        aeronave_id: AVION,
        monto: 44174.3,
        moneda: 'MXN',
        tc_usd_mxn: 18.6673,
        fecha_pago: '2026-10-28',
        referencia: 'Vuelo #498',
        notas: 'lo pidió',
        aceptar_exceso: false,
        client_request_id: KEY,
      },
      ACTOR,
    );
    expect(m.createCobro).toHaveBeenCalledTimes(1);
    const [vueloId, cobroDto, userId, rol, sobre, anticipo, interna] = m
      .createCobro.mock.calls[0] as unknown[];
    expect([vueloId, userId, rol, sobre, anticipo]).toEqual([
      VUELO,
      ACTOR.userId,
      Rol.DIRECCION,
      undefined,
      undefined,
    ]);
    expect(cobroDto).toEqual({
      monto: 44174.3,
      moneda: 'MXN',
      metodo_cobro: 'OTRO',
      tc_usd_mxn: 18.6673,
      fecha_cobro: new Date('2026-10-28T17:00:00.000Z'),
      notas: 'lo pidió',
      client_request_id: KEY,
    });
    // La fila de la entrega viaja TAL CUAL la armó «Pagos a socios».
    expect(interna).toEqual({ utilidades: { entrega: FILA } });
    expect(m.despuesDeVuelo).toHaveBeenCalledWith(SOCIO, 'e-1');
    expect(r).toEqual({
      cobro: expect.objectContaining({ id: 'c-1' }) as unknown,
      pago: { id: 'e-1', vuelo: { folio: 498 } },
      cuenta: { por_entregar_mxn: 37006.93 },
    });
    expect('idempotente' in r).toBe(false);
  });

  it('el mes del que se descuenta es el día de CANCÚN: las 03:00 UTC del 1-nov todavía son 31-oct', async () => {
    const m = armar();
    await m.svc.registrar(
      VUELO,
      dto({ fecha_cobro: new Date('2026-11-01T03:00:00.000Z') }),
      ACTOR,
    );
    expect(arg(m.prepararEntregaDeVuelo, 0, 0)).toMatchObject({
      fecha_pago: '2026-10-31',
    });
  });

  it('sin fecha: ahora; sin T.C.: el de la cotización del vuelo (en las dos filas)', async () => {
    const m = armar();
    await m.svc.registrar(
      VUELO,
      dto({ fecha_cobro: undefined, tc_usd_mxn: undefined }),
      ACTOR,
    );
    expect(arg(m.prepararEntregaDeVuelo, 0, 0)).toMatchObject({
      fecha_pago: '2026-11-23',
      tc_usd_mxn: 18.6673,
    });
    expect(arg(m.createCobro, 0, 1)).toMatchObject({
      tc_usd_mxn: 18.6673,
      fecha_cobro: new Date('2026-11-23T18:00:00.000Z'),
    });
  });

  it('en DÓLARES el cobro no lleva T.C. (como cualquier cobro en USD); la entrega sí lo recibe para saber sus pesos', async () => {
    const m = armar();
    await m.svc.registrar(VUELO, dto({ monto: 2465, moneda: 'USD' }), ACTOR);
    expect(arg(m.prepararEntregaDeVuelo, 0, 0)).toMatchObject({
      moneda: 'USD',
      tc_usd_mxn: 18.6673,
    });
    expect('tc_usd_mxn' in arg(m.createCobro, 0, 1)).toBe(false);
  });

  it('vuelo sin T.C. y sin T.C. capturado: la entrega recibe null (y responde 400 TC_REQUERIDO, que aquí se propaga)', async () => {
    const m = armar({ vuelo: { id: VUELO, folio: 601, tc_usd_mxn: null } });
    await m.svc.registrar(
      VUELO,
      dto({ monto: 2465, moneda: 'USD', tc_usd_mxn: undefined }),
      ACTOR,
    );
    expect(arg(m.prepararEntregaDeVuelo, 0, 0)).toMatchObject({
      tc_usd_mxn: null,
      referencia: 'Vuelo #601',
    });
  });

  it('si la entrega no pasa sus candados (adelanto sin confirmar) NO se llama al cobro: nada se escribe', async () => {
    const m = armar();
    m.prepararEntregaDeVuelo.mockRejectedValueOnce(
      new ConflictException({ message: 'Rebasa', error: 'PAGO_EXCEDE_SALDO' }),
    );
    await expect(m.svc.registrar(VUELO, dto(), ACTOR)).rejects.toMatchObject({
      response: { error: 'PAGO_EXCEDE_SALDO' },
    });
    expect(m.createCobro).not.toHaveBeenCalled();
    // Confirmado: `aceptar_exceso` llega a la entrega.
    await m.svc.registrar(VUELO, dto({ aceptar_exceso: true }), ACTOR);
    expect(arg(m.prepararEntregaDeVuelo, 1, 0)).toMatchObject({
      aceptar_exceso: true,
    });
    expect(m.createCobro).toHaveBeenCalledTimes(1);
  });

  it('si el cobro rebota (saldo del vuelo, mes cerrado…) el error llega tal cual', async () => {
    const m = armar();
    m.createCobro.mockRejectedValueOnce(
      new ConflictException({ message: 'Excede', error: 'COBRO_EXCEDE_SALDO' }),
    );
    await expect(m.svc.registrar(VUELO, dto(), ACTOR)).rejects.toMatchObject({
      response: { error: 'COBRO_EXCEDE_SALDO' },
    });
    expect(m.despuesDeVuelo).not.toHaveBeenCalled();
  });

  it('REPLAY: la llave ya tiene cobro en ese vuelo ⇒ lo devuelve con idempotente:true, sin candados ni escrituras', async () => {
    const m = armar({
      cobros: [
        {
          id: 'c-ya',
          vuelo_id: VUELO,
          client_request_id: KEY,
          reparto_pago_id: 'e-ya',
        },
      ],
    });
    const r = await m.svc.registrar(VUELO, dto(), ACTOR);
    expect(r).toMatchObject({ cobro: { id: 'c-ya' }, idempotente: true });
    expect(m.despuesDeVuelo).toHaveBeenCalledWith(SOCIO, 'e-ya');
    expect(m.findById).not.toHaveBeenCalled();
    expect(m.prepararEntregaDeVuelo).not.toHaveBeenCalled();
    expect(m.createCobro).not.toHaveBeenCalled();
  });

  it('replay detectado por el propio cobro (carrera): también sale idempotente', async () => {
    const m = armar();
    m.createCobro.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'c-otro',
        reparto_pago_id: 'e-1',
        idempotente: true,
      }),
    );
    // La relectura de la liga usa el id del cobro.
    const r = await armarConCobro(m, 'c-otro');
    expect(r).toMatchObject({ idempotente: true });
  });

  it('SIN la migración ⇒ 503 COBRO_UTILIDADES_NO_DISPONIBLE antes de leer el vuelo', async () => {
    const m = armar({ sinColumna: true });
    await expect(m.svc.registrar(VUELO, dto(), ACTOR)).rejects.toMatchObject({
      response: {
        error: 'COBRO_UTILIDADES_NO_DISPONIBLE',
        details: { migracion: '20261123000001' },
      },
    });
    expect(m.findById).not.toHaveBeenCalled();
    expect(m.createCobro).not.toHaveBeenCalled();
  });
});

/**
 * El cobro que devuelve `createCobro` en la carrera no está en la tabla del
 * fake: se arma un mundo con esa fila y se registra otra llave.
 */
async function armarConCobro(_m: ReturnType<typeof armar>, cobroId: string) {
  const m = armar({
    cobros: [{ id: cobroId, vuelo_id: 'otro-vuelo', reparto_pago_id: 'e-1' }],
  });
  m.createCobro.mockImplementationOnce(() =>
    Promise.resolve({ id: cobroId, reparto_pago_id: 'e-1', idempotente: true }),
  );
  return m.svc.registrar(VUELO, dto(), ACTOR);
}
