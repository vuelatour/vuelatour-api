// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// Este spec es el camino SIN la migración de las vigencias (10-nov-2026,
// invariante 130): solo existe la tabla por motor, como el 9-nov. El camino
// con «a partir de» vive en `aircraft.service.reserva-vigencia.spec.ts`.
jest.mock('../../common/reserva-overhaul.lector', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/reserva-overhaul.lector',
  ),
  reservaVigenciaDisponible: jest.fn(() => Promise.resolve(false)),
}));

import { AircraftService } from './aircraft.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CreateAeronaveDto } from './dto/create-aeronave.dto';

/**
 * LA FICHA DEL AVIÓN MANDA EN LA RESERVA DE OVERHAUL (9-nov-2026, API
 * 0.0.131, invariante 126). Pregunta de Ale: «en la edición del avión dice
 * 200 dólares, pero el balance sigue multiplicando las horas por 400». La
 * ficha (`aeronave.reserva_overhaul_hr_usd`) y la tabla por motor
 * (`reserva_overhaul.monto_por_hora_usd`, lo que leen balance y reparto) no
 * estaban conectadas. Al guardar la ficha con tarifa, cada motor del avión
 * queda con esa tarifa; sin motores, una fila sin motor.
 */
type Llamada = { tabla: string; metodo: string; args: unknown[] };

function armar(mundo: {
  motores?: string[];
  filas?: Array<{ id: string; motor_id: string | null }>;
}) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    const reg =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'in',
      'is',
      'or',
      'order',
      'insert',
      'update',
      'upsert',
      'delete',
      'limit',
    ])
      q[m] = reg(m);
    const resolver = () => {
      if (tabla === 'aeronave') {
        return {
          data: {
            id: 'a-1',
            matricula: 'N621TX',
            reserva_overhaul_hr_usd: 200,
          },
          error: null,
          count: 0,
        };
      }
      if (tabla === 'motor')
        return {
          data: (mundo.motores ?? []).map((id) => ({ id })),
          error: null,
          count: 0,
        };
      if (tabla === 'reserva_overhaul') {
        const ultima = llamadas.filter((l) => l.tabla === tabla).slice(-3);
        // La lectura (`select`) devuelve las filas; las escrituras, vacío.
        return ultima.some((l) => l.metodo === 'select')
          ? { data: mundo.filas ?? [], error: null, count: 0 }
          : { data: null, error: null, count: 0 };
      }
      return { data: [], error: null, count: 0 };
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const service = new AircraftService(supabase, {} as never, {} as never);
  // La sonda de la columna `combustible` y la de servicio no son el tema.
  Object.assign(service as unknown as Record<string, unknown>, {
    prepararCombustible: () => Promise.resolve(),
    aeronaveCols: () => Promise.resolve('id, matricula'),
  });
  return { service, llamadas };
}

const deReserva = (ll: Llamada[]) =>
  ll.filter((l) => l.tabla === 'reserva_overhaul').map((l) => l.metodo);

describe('Reserva de overhaul — la ficha manda (invariante 126)', () => {
  it('update con tarifa y dos motores: upsert de UNA fila por motor con la tarifa (onConflict aeronave_id,motor_id) y nada se borra', async () => {
    const { service, llamadas } = armar({
      motores: ['m-izq', 'm-der'],
      filas: [
        { id: 'r-1', motor_id: 'm-izq' },
        { id: 'r-2', motor_id: 'm-der' },
      ],
    });
    await service.update('a-1', { reserva_overhaul_hr_usd: 200 }, 'u-ale');
    const upsert = llamadas.find(
      (l) => l.tabla === 'reserva_overhaul' && l.metodo === 'upsert',
    )!;
    expect(upsert).toBeDefined();
    const filas = upsert.args[0] as Array<Record<string, unknown>>;
    expect(
      filas.map((f) => [f.aeronave_id, f.motor_id, f.monto_por_hora_usd]),
    ).toEqual([
      ['a-1', 'm-izq', 200],
      ['a-1', 'm-der', 200],
    ]);
    expect(upsert.args[1]).toEqual({ onConflict: 'aeronave_id,motor_id' });
    expect(deReserva(llamadas)).not.toContain('delete');
    expect(deReserva(llamadas)).not.toContain('insert');
  });

  it('con motores y una fila suelta sin motor (alta previa): se upsertea por motor y la suelta se retira (no suma de más)', async () => {
    const { service, llamadas } = armar({
      motores: ['m-1'],
      filas: [{ id: 'r-vieja', motor_id: null }],
    });
    await service.update('a-1', { reserva_overhaul_hr_usd: 55 }, 'u-ale');
    expect(deReserva(llamadas)).toContain('upsert');
    const borrar = llamadas.find(
      (l) => l.tabla === 'reserva_overhaul' && l.metodo === 'in',
    )!;
    expect(borrar.args).toEqual(['id', ['r-vieja']]);
    expect(deReserva(llamadas)).toContain('delete');
  });

  it('sin motores dados de alta: actualiza las filas que haya; sin filas, inserta una sin motor', async () => {
    const con = armar({ motores: [], filas: [{ id: 'r-1', motor_id: null }] });
    await con.service.update('a-1', { reserva_overhaul_hr_usd: 120 }, 'u');
    const upd = con.llamadas.find(
      (l) => l.tabla === 'reserva_overhaul' && l.metodo === 'update',
    )!;
    expect(upd.args[0]).toMatchObject({ monto_por_hora_usd: 120 });
    expect(deReserva(con.llamadas)).not.toContain('insert');
    expect(deReserva(con.llamadas)).not.toContain('upsert');

    const sin = armar({ motores: [], filas: [] });
    await sin.service.update('a-1', { reserva_overhaul_hr_usd: 120 }, 'u');
    const ins = sin.llamadas.find(
      (l) => l.tabla === 'reserva_overhaul' && l.metodo === 'insert',
    )!;
    expect(ins.args[0]).toEqual({
      aeronave_id: 'a-1',
      motor_id: null,
      monto_por_hora_usd: 120,
    });
  });

  it('sin la tarifa en el DTO, vacía o 0: la tabla por motor no se toca (su check exige > 0)', async () => {
    for (const dto of [
      { notas: 'x' },
      { reserva_overhaul_hr_usd: 0 },
      { reserva_overhaul_hr_usd: null as unknown as number },
    ]) {
      const { service, llamadas } = armar({ motores: ['m-1'], filas: [] });
      await service.update('a-1', dto, 'u');
      expect(deReserva(llamadas)).toEqual([]);
    }
  });

  it('create con tarifa: tras el insert del avión sincroniza igual (sin motores todavía ⇒ una fila sin motor)', async () => {
    const { service, llamadas } = armar({ motores: [], filas: [] });
    await service.create(
      {
        matricula: 'XB-NUE',
        modelo: 'C206',
        reserva_overhaul_hr_usd: 55,
      } as unknown as CreateAeronaveDto,
      'u',
    );
    const ins = llamadas.find(
      (l) => l.tabla === 'reserva_overhaul' && l.metodo === 'insert',
    )!;
    expect(ins.args[0]).toEqual({
      aeronave_id: 'a-1',
      motor_id: null,
      monto_por_hora_usd: 55,
    });
  });
});
