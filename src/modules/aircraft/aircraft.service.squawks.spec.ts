// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { AircraftService } from './aircraft.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Lote 2 Ola B (10-sep-2026) en squawks:
 *  - B2: POST /aircraft/:id/squawks idempotente por `client_request_id`
 *    (pre-check por llave, 23505 sobre uq_discrepancia_client_request);
 *    con la columna ausente (migración pendiente) alta de siempre.
 *  - B1: PATCH /aircraft/squawks/:id con `if_updated_at` → CAS (la tabla
 *    SÍ tiene trigger) y 409 CONFLICTO_VERSION («reporte»).
 */
type Resultado = {
  data: unknown;
  error: null | { code?: string; message: string };
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };

function armar(tablas: Record<string, Resultado[]>, columnaLlave = true) {
  const llamadas: Llamada[] = [];
  const cursor: Record<string, number> = {};
  const siguiente = (tabla: string): Resultado => {
    const lista = tablas[tabla] ?? [{ data: null, error: null }];
    const i = cursor[tabla] ?? 0;
    cursor[tabla] = i + 1;
    return lista[Math.min(i, lista.length - 1)];
  };
  const from = (tabla: string) => {
    llamadas.push({ tabla, metodo: 'from', args: [tabla] });
    const cadena: Llamada[] = [];
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        const l = { tabla, metodo, args };
        llamadas.push(l);
        cadena.push(l);
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'gte',
      'lte',
      'order',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = registra(m);
    }
    const resolver = (): Resultado => {
      const sel = cadena.find((l) => l.metodo === 'select');
      const esSonda =
        cadena.length === 2 &&
        cadena.some((l) => l.metodo === 'limit') &&
        sel?.args[0] === 'client_request_id';
      if (esSonda) {
        return columnaLlave
          ? { data: [], error: null }
          : {
              data: null,
              error: {
                code: '42703',
                message:
                  'column aeronave_discrepancia.client_request_id does not exist',
              },
            };
      }
      return siguiente(tabla);
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (
      resolve: (v: Resultado) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const nada = {} as never;
  return { service: new AircraftService(supabase, nada, nada), llamadas };
}

const de = (llamadas: Llamada[], tabla: string, metodo: string) =>
  llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo);

const KEY = '22222222-2222-4222-8222-222222222222';
const SQUAWK = {
  id: 's-1',
  aeronave_id: 'a-1',
  descripcion: 'Fuga de aceite',
  severidad: 'ALTA',
  estado: 'ABIERTA',
  created_at: '2026-09-10T10:00:00+00:00',
  updated_at: '2026-09-10T15:00:00.123456+00:00',
  client_request_id: KEY,
};

describe('AircraftService.createDiscrepancia — B2 idempotencia', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('alta fresca con llave: pre-check vacío → insert CON client_request_id → idempotente:false', async () => {
    const { service, llamadas } = armar({
      aeronave: [{ data: { id: 'a-1' }, error: null }],
      aeronave_discrepancia: [
        { data: null, error: null }, // pre-check por llave
        { data: SQUAWK, error: null }, // insert
      ],
    });
    const res = await service.createDiscrepancia(
      'a-1',
      {
        descripcion: 'Fuga de aceite',
        severidad: 'ALTA',
        client_request_id: KEY,
      },
      'u-mec',
    );
    expect(res).toMatchObject({
      id: 's-1',
      client_request_id: KEY,
      idempotente: false,
    });
    const insert = de(llamadas, 'aeronave_discrepancia', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      aeronave_id: 'a-1',
      descripcion: 'Fuga de aceite',
      client_request_id: KEY,
      reportado_por: 'u-mec',
    });
    // El pre-check filtra por la llave y el select incluye la columna.
    expect(de(llamadas, 'aeronave_discrepancia', 'eq')[0].args).toEqual([
      'client_request_id',
      KEY,
    ]);
    expect(
      String(de(llamadas, 'aeronave_discrepancia', 'select')[0].args[0]),
    ).toMatch(/client_request_id/);
  });

  it('replay (pre-check encuentra la fila): devuelve el existente con idempotente:true, sin insert ni re-validar el avión', async () => {
    const { service, llamadas } = armar({
      aeronave_discrepancia: [{ data: SQUAWK, error: null }],
    });
    const res = await service.createDiscrepancia(
      'a-1',
      { descripcion: 'Fuga de aceite', client_request_id: KEY },
      'u-mec',
    );
    expect(res).toEqual({ ...SQUAWK, idempotente: true });
    expect(de(llamadas, 'aeronave_discrepancia', 'insert')).toHaveLength(0);
    expect(de(llamadas, 'aeronave', 'from')).toHaveLength(0);
  });

  it('carrera: 23505 sobre uq_discrepancia_client_request → relee y devuelve idempotente:true', async () => {
    const { service } = armar({
      aeronave: [{ data: { id: 'a-1' }, error: null }],
      aeronave_discrepancia: [
        { data: null, error: null }, // pre-check
        {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "uq_discrepancia_client_request"',
          },
        },
        { data: SQUAWK, error: null }, // relectura
      ],
    });
    const res = await service.createDiscrepancia(
      'a-1',
      { descripcion: 'Fuga de aceite', client_request_id: KEY },
      'u-mec',
    );
    expect(res).toMatchObject({ id: 's-1', idempotente: true });
  });

  it('llave usada en OTRO avión: 23505 y la relectura acotada al avión no encuentra → 409 CLIENT_REQUEST_ID_EN_USO (nunca 500 ni el reporte ajeno)', async () => {
    const { service, llamadas } = armar({
      aeronave: [{ data: { id: 'a-1' }, error: null }],
      aeronave_discrepancia: [
        { data: null, error: null }, // pre-check acotado al avión
        {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "uq_discrepancia_client_request"',
          },
        },
        { data: null, error: null }, // relectura acotada: nada en este avión
      ],
    });
    let err: unknown;
    try {
      await service.createDiscrepancia(
        'a-1',
        { descripcion: 'Fuga de aceite', client_request_id: KEY },
        'u-mec',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error: 'CLIENT_REQUEST_ID_EN_USO',
      details: { client_request_id: KEY },
    });
    // Pre-check y relectura acotan por avión, no solo por llave.
    const porAvion = de(llamadas, 'aeronave_discrepancia', 'eq').filter(
      (l) => l.args[0] === 'aeronave_id' && l.args[1] === 'a-1',
    );
    expect(porAvion).toHaveLength(2);
  });

  it('columna ausente (migración pendiente): sin pre-check, insert SIN la llave, respuesta con client_request_id null', async () => {
    const { service, llamadas } = armar(
      {
        aeronave: [{ data: { id: 'a-1' }, error: null }],
        aeronave_discrepancia: [
          { data: { ...SQUAWK, client_request_id: undefined }, error: null },
        ],
      },
      false,
    );
    const res = await service.createDiscrepancia(
      'a-1',
      { descripcion: 'Fuga de aceite', client_request_id: KEY },
      'u-mec',
    );
    expect(res).toMatchObject({
      id: 's-1',
      client_request_id: null,
      idempotente: false,
    });
    const insert = de(llamadas, 'aeronave_discrepancia', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(insert).not.toHaveProperty('client_request_id');
    expect(de(llamadas, 'aeronave_discrepancia', 'eq')).toHaveLength(0);
    // El select del insert (no el de la sonda) omite la columna ausente.
    const selects = de(llamadas, 'aeronave_discrepancia', 'select').filter(
      (l) => l.args[0] !== 'client_request_id',
    );
    expect(selects).toHaveLength(1);
    expect(String(selects[0].args[0])).not.toMatch(/client_request_id/);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sin llave: alta de siempre (sin pre-check, sin columna en el insert)', async () => {
    const { service, llamadas } = armar({
      aeronave: [{ data: { id: 'a-1' }, error: null }],
      aeronave_discrepancia: [{ data: SQUAWK, error: null }],
    });
    await service.createDiscrepancia('a-1', { descripcion: 'x' }, 'u-mec');
    const insert = de(llamadas, 'aeronave_discrepancia', 'insert')[0]
      .args[0] as Record<string, unknown>;
    expect(insert).not.toHaveProperty('client_request_id');
    expect(de(llamadas, 'aeronave_discrepancia', 'eq')).toHaveLength(0);
  });
});

describe('AircraftService.updateDiscrepancia — B1 if_updated_at', () => {
  it('con if_updated_at: ventana ±1 ms; client_request_id del DTO se ignora', async () => {
    const { service, llamadas } = armar({
      aeronave_discrepancia: [
        { data: { ...SQUAWK, estado: 'RESUELTA' }, error: null },
      ],
    });
    const res = await service.updateDiscrepancia(
      's-1',
      {
        estado: 'RESUELTA',
        if_updated_at: '2026-09-10T15:00:00.123Z',
        client_request_id: KEY,
      },
      'u-mec',
    );
    expect(res).toMatchObject({ id: 's-1', estado: 'RESUELTA' });
    expect(de(llamadas, 'aeronave_discrepancia', 'gte')[0].args).toEqual([
      'updated_at',
      '2026-09-10T15:00:00.122Z',
    ]);
    expect(de(llamadas, 'aeronave_discrepancia', 'lte')[0].args).toEqual([
      'updated_at',
      '2026-09-10T15:00:00.124Z',
    ]);
    const payload = de(llamadas, 'aeronave_discrepancia', 'update')[0]
      .args[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('if_updated_at');
    expect(payload).not.toHaveProperty('client_request_id');
    expect(payload).toMatchObject({
      estado: 'RESUELTA',
      resuelto_por: 'u-mec',
    });
  });

  it('0 filas con CAS → 409 CONFLICTO_VERSION («reporte»); sin llave → 404', async () => {
    const vivo = { ...SQUAWK, updated_at: '2026-09-10T16:00:00+00:00' };
    const { service } = armar({
      aeronave_discrepancia: [
        { data: null, error: null },
        { data: vivo, error: null },
      ],
    });
    let err: unknown;
    try {
      await service.updateDiscrepancia(
        's-1',
        { estado: 'RESUELTA', if_updated_at: '2026-09-10T15:00:00.123Z' },
        'u-mec',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Record<
      string,
      unknown
    >;
    expect(body.error).toBe('CONFLICTO_VERSION');
    expect(body.message).toMatch(/modificó este reporte/);
    expect(body.details).toEqual({
      actual: vivo,
      updated_at_enviado: '2026-09-10T15:00:00.123Z',
      updated_at_actual: '2026-09-10T16:00:00+00:00',
    });

    const sinLlave = armar({
      aeronave_discrepancia: [{ data: null, error: null }],
    });
    await expect(
      sinLlave.service.updateDiscrepancia('s-1', { estado: 'RESUELTA' }, 'u'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
