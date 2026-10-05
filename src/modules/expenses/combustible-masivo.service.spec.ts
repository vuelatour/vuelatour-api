// Módulos pesados que el servicio importa solo para inyección.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('./expenses.service', () => ({ ExpensesService: class {} }));

import { CombustibleMasivoService } from './combustible-masivo.service';
import {
  EstatusComprobante,
  MedioPago,
  Moneda,
  TipoCombustible,
} from './dto/expenses.dto';
import type { FilaCombustibleDto } from './dto/combustible-masivo.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { FilaCombustibleCruda } from '../pyservices/pyservices.service';
import type { ExpensesService } from './expenses.service';
import { Rol } from '../../common/types/auth.types';

/**
 * Carga masiva de combustibles × combustible del avión (5-oct-2026,
 * invariante 43). Misma regla que el alta: tipo vacío ⇒ el del avión; tipo
 * distinto ⇒ ADVERTENCIA en el preview (no error: la fila se puede cargar) y,
 * al guardar, `create` lo corrige y la respuesta lo reporta en `avisos`. Sin
 * la migración, el preview y la carga se comportan como el 0.0.55.
 */
const PEV = '11111111-1111-4111-8111-111111111111';
const N621TX = '22222222-2222-4222-8222-222222222222';
const FLOTA = [
  { id: PEV, matricula: 'XB-PEV', activa: true, combustible: 'AVGAS' },
  { id: N621TX, matricula: 'N621TX', activa: true, combustible: 'TURBOSINA' },
];

function armar(opts: { sinColumna?: boolean } = {}) {
  const selectsAeronave: string[] = [];
  const supabase = {
    service: {
      from: (tabla: string) => {
        let sel = '';
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is']) {
          q[m] = (...a: unknown[]) => {
            if (m === 'select') {
              sel = String(a[0]);
              if (tabla === 'aeronave') selectsAeronave.push(sel);
            }
            return q;
          };
        }
        const resolver = () => {
          if (tabla === 'aeronave' && sel === 'combustible') {
            return opts.sinColumna
              ? {
                  data: null,
                  error: { code: '42703', message: 'column does not exist' },
                }
              : { data: [], error: null };
          }
          if (tabla === 'aeronave') {
            return {
              data: FLOTA.map((a) =>
                sel.includes('combustible')
                  ? a
                  : { id: a.id, matricula: a.matricula, activa: a.activa },
              ),
              error: null,
            };
          }
          return { data: [], error: null };
        };
        q.then = (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(resolver()).then(resolve, reject);
        return q;
      },
    },
  } as unknown as SupabaseService;
  const filasCrudas: FilaCombustibleCruda[] = [];
  const pyservices = {
    parseCombustible: jest.fn(() => Promise.resolve({ filas: filasCrudas })),
  } as unknown as PyservicesService;
  // `create` real ajusta el combustible (se prueba en
  // expenses.service.combustible.spec); aquí se simula su resultado.
  const create = jest.fn(
    (dto: { aeronave_id: string; tipo_combustible?: string }) =>
      Promise.resolve({
        id: `g-${dto.aeronave_id}`,
        tipo_combustible:
          FLOTA.find((a) => a.id === dto.aeronave_id)?.combustible ??
          dto.tipo_combustible ??
          null,
      }),
  );
  const expenses = { create } as unknown as ExpensesService;
  const service = new CombustibleMasivoService(supabase, pyservices, expenses);
  return { service, filasCrudas, selectsAeronave, create };
}

const HOY = new Date('2026-09-12T18:00:00Z');

function cruda(extra: Partial<FilaCombustibleCruda>): FilaCombustibleCruda {
  return {
    fila: 2,
    matricula: 'XB-PEV',
    fecha: '2026-09-10',
    hora: '10:30',
    litros: 74,
    monto: 2738.5,
    moneda: 'MXN',
    tipo_cambio: 17.5,
    tipo_combustible: null,
    lugar: 'CTM',
    proveedor: null,
    medio_pago: 'EFECTIVO',
    folio_vuelo: null,
    comprobante: 'TICKET',
    notas: null,
    ...extra,
  };
}

function fila(extra: Partial<FilaCombustibleDto>): FilaCombustibleDto {
  return {
    fila: 2,
    aeronave_id: PEV,
    matricula: 'XB-PEV',
    fecha_gasto: '2026-09-10',
    fecha_hora_carga: '2026-09-10T10:30:00-05:00',
    litros: 74,
    monto: 2738.5,
    moneda: Moneda.MXN,
    medio_pago: MedioPago.EFECTIVO,
    estatus_comprobante: EstatusComprobante.VALE,
    ...extra,
  };
}

describe('CombustibleMasivoService — combustible del avión', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('preview: vacío ⇒ el del avión sin aviso; distinto ⇒ advertencia (no error); igual ⇒ nada', async () => {
    const { service, filasCrudas, selectsAeronave } = armar();
    filasCrudas.push(
      cruda({ fila: 2, tipo_combustible: null }),
      cruda({ fila: 3, tipo_combustible: 'Turbosina', monto: 1000 }),
      cruda({
        fila: 4,
        matricula: 'N621TX',
        tipo_combustible: 'TURBOSINA',
        monto: 2000,
      }),
    );
    const r = await service.preview({
      archivo_base64: 'x',
      filename: 'c.xlsx',
    });
    const [vacio, distinto, igual] = r.filas;
    expect(vacio.datos.tipo_combustible).toBe('AVGAS');
    expect(vacio.advertencias).toEqual([]);
    expect(distinto.ok).toBe(true);
    expect(distinto.errores).toEqual([]);
    expect(distinto.datos.tipo_combustible).toBe('TURBOSINA');
    expect(distinto.advertencias).toEqual([
      'La fila dice Turbosina pero el XB-PEV carga Gasavión: se guardará como Gasavión y quedará marcada para revisión.',
    ]);
    expect(igual.advertencias).toEqual([]);
    expect(r.resumen).toMatchObject({ validas: 3, con_advertencia: 1 });
    expect(selectsAeronave).toContain('id, matricula, activa, combustible');
  });

  it('preview: un tipo inválido sigue siendo ERROR y no se rellena', async () => {
    const { service, filasCrudas } = armar();
    filasCrudas.push(cruda({ tipo_combustible: 'DIESEL' }));
    const r = await service.preview({
      archivo_base64: 'x',
      filename: 'c.xlsx',
    });
    expect(r.filas[0].ok).toBe(false);
    expect(r.filas[0].datos.tipo_combustible).toBeUndefined();
    expect(r.filas[0].advertencias).toEqual([]);
  });

  it('preview SIN la migración: ni aviso ni relleno, y la flota se lee sin la columna', async () => {
    const { service, filasCrudas, selectsAeronave } = armar({
      sinColumna: true,
    });
    filasCrudas.push(
      cruda({ fila: 2, tipo_combustible: null }),
      cruda({ fila: 3, tipo_combustible: 'TURBOSINA', monto: 1000 }),
    );
    const r = await service.preview({
      archivo_base64: 'x',
      filename: 'c.xlsx',
    });
    expect(r.filas[0].datos.tipo_combustible).toBeUndefined();
    expect(r.filas[1].advertencias).toEqual([]);
    expect(selectsAeronave).toContain('id, matricula, activa');
    expect(selectsAeronave).not.toContain('id, matricula, activa, combustible');
  });

  it('carga: la fila corregida se CREA y se reporta en `avisos` (no en errores)', async () => {
    const { service, create } = armar();
    const r = await service.cargaMasiva(
      {
        filas: [
          fila({ fila: 2, tipo_combustible: TipoCombustible.TURBOSINA }),
          fila({ fila: 3, tipo_combustible: TipoCombustible.AVGAS, monto: 10 }),
          fila({ fila: 4, monto: 20 }),
        ],
      },
      'u-admin',
      Rol.ADMIN,
    );
    expect(create).toHaveBeenCalledTimes(3);
    expect(r.creados).toBe(3);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toEqual([
      {
        fila: 2,
        aviso:
          'La fila decía Turbosina pero el XB-PEV carga Gasavión: se guardó como Gasavión y quedó marcada para revisión.',
      },
    ]);
    // `create` recibe lo que trae la fila (él aplica la regla única) y sin push.
    expect(create.mock.calls[0][0]).toMatchObject({
      tipo_combustible: 'TURBOSINA',
      aeronave_id: PEV,
    });
    expect((create.mock.calls[0] as unknown[])[3]).toEqual({
      notificar: false,
    });
  });

  it('carga: si el gasto quedó con el tipo de la fila (sin migración), no hay aviso', async () => {
    const { service, create } = armar();
    create.mockImplementationOnce((dto) =>
      Promise.resolve({
        id: 'g',
        tipo_combustible: dto.tipo_combustible ?? null,
      }),
    );
    const r = await service.cargaMasiva(
      { filas: [fila({ tipo_combustible: TipoCombustible.TURBOSINA })] },
      'u-admin',
      Rol.ADMIN,
    );
    expect(r.avisos).toEqual([]);
  });
});
