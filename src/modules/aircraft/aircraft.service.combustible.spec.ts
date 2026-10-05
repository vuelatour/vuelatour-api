// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { AircraftService } from './aircraft.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CreateAeronaveDto } from './dto/create-aeronave.dto';
import type { UpdateAeronaveDto } from './dto/update-aeronave.dto';

/**
 * `aeronave.combustible` en la flota (5-oct-2026, API 0.0.56, migración
 * 20261005000001). Con la columna: listado/detalle la devuelven (ADITIVO),
 * el alta sin valor pone AVGAS y la edición con `null` no la toca. SIN la
 * columna (migración pendiente): todo como el 0.0.55 — ni el select ni el
 * insert la nombran (si no, 42703/PGRST204 ⇒ 500 en toda la flota).
 */
type Llamada = { tabla: string; metodo: string; args: unknown[] };

function armar(opts: { sinColumna?: boolean } = {}) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    let selectArg = '';
    const q: Record<string, unknown> = {};
    const reg =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
        if (metodo === 'select') selectArg = String(args[0]);
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'or',
      'order',
      'range',
      'limit',
      'insert',
      'update',
    ]) {
      q[m] = reg(m);
    }
    const resolver = () => {
      // La sonda de la columna: `select('combustible').limit(1)`.
      if (tabla === 'aeronave' && selectArg === 'combustible') {
        return opts.sinColumna
          ? {
              data: null,
              error: {
                code: '42703',
                message: 'column aeronave.combustible does not exist',
              },
              count: null,
            }
          : { data: [], error: null, count: 0 };
      }
      if (tabla === 'aeronave') {
        return {
          data: { id: 'a-pev', matricula: 'XB-PEV', combustible: 'AVGAS' },
          error: null,
          count: 0,
        };
      }
      return { data: [], error: null, count: 0 };
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const r = resolver();
      // El listado lee un ARREGLO: vacío para no entrar al resto del armado.
      const lista =
        tabla === 'aeronave' && selectArg !== 'combustible'
          ? { data: [], error: null, count: 0 }
          : r;
      return Promise.resolve(lista).then(resolve, reject);
    };
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const service = new AircraftService(supabase, {} as never, {} as never);
  return { service, llamadas };
}

const selectsDeFlota = (llamadas: Llamada[]) =>
  llamadas
    .filter(
      (l) =>
        l.tabla === 'aeronave' &&
        l.metodo === 'select' &&
        l.args[0] !== 'combustible',
    )
    .map((l) => String(l.args[0]));

const payload = (llamadas: Llamada[], metodo: 'insert' | 'update') =>
  llamadas.find((l) => l.tabla === 'aeronave' && l.metodo === metodo)
    ?.args[0] as Record<string, unknown>;

const ALTA: CreateAeronaveDto = {
  matricula: 'N58BT',
  modelo: 'PIPER Meridian',
  pais_registro: 'USA',
  num_motores: 1,
  velocidad_crucero_kts: 250,
  asientos: 5,
};

describe('AircraftService — combustible (con la migración)', () => {
  it('listado y detalle piden la columna (campo ADITIVO)', async () => {
    const { service, llamadas } = armar();
    await service.list({ limit: 50, offset: 0 });
    const det = await service.findById('a-pev');
    const selects = selectsDeFlota(llamadas);
    expect(selects).toHaveLength(2);
    for (const s of selects) expect(s).toMatch(/, combustible$/);
    expect(det).toMatchObject({ combustible: 'AVGAS' });
  });

  it('alta sin combustible ⇒ AVGAS (default de pistón); con TURBOSINA ⇒ TURBOSINA', async () => {
    const a = armar();
    await a.service.create({ ...ALTA }, 'u-admin');
    expect(payload(a.llamadas, 'insert')).toMatchObject({
      matricula: 'N58BT',
      combustible: 'AVGAS',
    });
    const b = armar();
    await b.service.create({ ...ALTA, combustible: 'TURBOSINA' }, 'u-admin');
    expect(payload(b.llamadas, 'insert').combustible).toBe('TURBOSINA');
    expect(selectsDeFlota(b.llamadas)[0]).toMatch(/, combustible$/);
  });

  it('edición: TURBOSINA viaja; null o ausente NO se manda (columna NOT NULL)', async () => {
    const a = armar();
    await a.service.update('a-pev', { combustible: 'TURBOSINA' }, 'u-admin');
    expect(payload(a.llamadas, 'update')).toMatchObject({
      combustible: 'TURBOSINA',
      updated_by: 'u-admin',
    });
    const b = armar();
    await b.service.update(
      'a-pev',
      { combustible: null, notas: 'x' } as unknown as UpdateAeronaveDto,
      'u-admin',
    );
    expect(payload(b.llamadas, 'update')).not.toHaveProperty('combustible');
    const c = armar();
    await c.service.update(
      'a-pev',
      { notas: 'x', combustible: undefined },
      'u-admin',
    );
    expect(payload(c.llamadas, 'update')).not.toHaveProperty('combustible');
  });
});

describe('AircraftService — combustible SIN la migración (API antes que la BD)', () => {
  it('ni el listado ni el detalle nombran la columna', async () => {
    const { service, llamadas } = armar({ sinColumna: true });
    await service.list({ limit: 50, offset: 0 });
    await service.findById('a-pev');
    for (const s of selectsDeFlota(llamadas)) {
      expect(s).not.toMatch(/combustible/);
    }
  });

  it('alta y edición omiten el campo aunque venga (no 500)', async () => {
    const a = armar({ sinColumna: true });
    await a.service.create({ ...ALTA, combustible: 'TURBOSINA' }, 'u-admin');
    expect(payload(a.llamadas, 'insert')).not.toHaveProperty('combustible');
    const b = armar({ sinColumna: true });
    await b.service.update('a-pev', { combustible: 'TURBOSINA' }, 'u-admin');
    expect(payload(b.llamadas, 'update')).not.toHaveProperty('combustible');
  });
});
