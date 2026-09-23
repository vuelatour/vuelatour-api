// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { BadRequestException } from '@nestjs/common';
import { AircraftService } from '../aircraft/aircraft.service';
import { PropellersService } from './propellers.service';
import { EnginesService } from '../engines/engines.service';
import { mensajeTurmSuperaTotales } from '../../common/turm-componente.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { CreatePropellerDto } from './dto/propellers.dto';
import { PosicionHelice } from './dto/propellers.dto';
import type { CreateEngineDto } from '../engines/dto/engines.dto';
import { PosicionMotor, TipoMotor } from '../engines/dto/engines.dto';

/**
 * T.U.R.M. = TSO (reporte de la oficina, 22-sep-2026).
 *
 * «En la hélice del XB-ANU no está haciendo bien la resta y se sale de
 * parámetros»: la ficha mostraba TSN 2,708.00 · TSO 2,344.00 · TURM 364.00 ·
 * TBO 2,000 · Restantes −344.00 · Vida usada 100 %, con el avión marcado
 * «TBO agotado» en el semáforo de aptitud.
 *
 * Causa: `turm_componente` se leía como «horas del componente EN su último
 * overhaul» y se guardaba `tso_base = horas_totales − turm_componente`
 * (2708 − 364 = 2344). En la bitácora física T.U.R.M. es el TIEMPO desde la
 * Última Reparación Mayor — o sea el TSO. Aquí se congela la lectura
 * correcta, de punta a punta: lo que se GUARDA (`create`/`update`) y lo que
 * se DEVUELVE (`componenteEstado`).
 */

const AVION = 'aaaaaaaa-0000-4000-8000-0000000xbanu';
const HELICE = 'bbbbbbbb-0000-4000-8000-000000782316';
const USUARIO = 'cccccccc-0000-4000-8000-00000000000c';

/** Datos REALES de prod el 22-sep-2026 (hélice s/n 782316 del XB-ANU). */
const XB_ANU = {
  horas_totales: 2708,
  turm_capturado: 364,
  tbo_horas: 2000,
  /** Ancla actual de la fila; el taco del avión no la rebasa (delta 0). */
  aeronave_horas_ref: 1381.6,
};

type Res = { data?: unknown; error?: unknown };
const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'or',
  'order',
  'limit',
  'range',
  'insert',
  'update',
  'delete',
];

/**
 * Supabase de juguete: devuelve `filaGuardada` en las lecturas y CAPTURA los
 * payloads de insert/update para poder afirmar qué se escribió.
 */
function armarSupabase(filaGuardada: Record<string, unknown> | null) {
  const escrituras: Array<{ tabla: string; op: string; payload: unknown }> = [];
  const service = {
    from(tabla: string) {
      const q: Record<string, unknown> = {};
      const res = (): Res => ({ data: filaGuardada, error: null });
      for (const m of METODOS) {
        q[m] = (...args: unknown[]) => {
          if (m === 'insert' || m === 'update') {
            escrituras.push({ tabla, op: m, payload: args[0] });
          }
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(res());
      q.single = () => Promise.resolve(res());
      q.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(r);
      return q;
    },
  };
  return { service: { service } as unknown as SupabaseService, escrituras };
}

/** AircraftService REAL (su `componenteEstado` es la aritmética bajo prueba). */
function armarAircraft(hobbs: number) {
  const aircraft = new AircraftService(
    { service: {} } as unknown as SupabaseService,
    {} as ExpirationsService,
    {} as PyservicesService,
  );
  jest.spyOn(aircraft, 'currentHobbs').mockResolvedValue(hobbs);
  return aircraft;
}

/**
 * Payload de la escritura sobre la tabla del COMPONENTE (`helice`/`motor`):
 * el alta escribe además en `componente_evento` (la bitácora) y ese insert
 * no es el que se afirma aquí.
 */
const ultimoPayload = (
  escrituras: Array<{ tabla: string; op: string; payload: unknown }>,
  op: 'insert' | 'update',
): Record<string, unknown> =>
  (escrituras
    .filter((e) => e.op === op && (e.tabla === 'helice' || e.tabla === 'motor'))
    .at(-1)?.payload ?? {}) as Record<string, unknown>;

describe('T.U.R.M. de la bitácora = TSO · hélice del XB-ANU', () => {
  const dtoAlta: CreatePropellerDto = {
    aeronave_id: AVION,
    posicion: PosicionHelice.UNICA,
    numero_serie: '782316',
    horas_totales: XB_ANU.horas_totales,
    turm_componente: XB_ANU.turm_capturado,
    tbo_horas: XB_ANU.tbo_horas,
  };

  it('ALTA: T.T. 2708 + T.U.R.M. 364 ⇒ tso_base 364 (antes 2344)', async () => {
    const { service, escrituras } = armarSupabase({ id: HELICE });
    const svc = new PropellersService(service, armarAircraft(1381.6));
    await svc.create(dtoAlta, USUARIO);
    expect(ultimoPayload(escrituras, 'insert').tso_base).toBe(364);
  });

  it('ALTA: la bitácora del componente registra 364 h desde el overhaul', async () => {
    const { service, escrituras } = armarSupabase({ id: HELICE });
    const svc = new PropellersService(service, armarAircraft(1381.6));
    await svc.create(dtoAlta, USUARIO);
    const evento = escrituras.find((e) => e.tabla === 'componente_evento');
    expect(
      (evento?.payload as Record<string, unknown>).horas_desde_overhaul,
    ).toBe(364);
  });

  it('EDICIÓN: capturar solo el T.U.R.M. escribe tso_base = T.U.R.M.', async () => {
    const { service, escrituras } = armarSupabase({
      id: HELICE,
      aeronave_id: AVION,
      horas_totales: XB_ANU.horas_totales,
      tso_base: 2344,
      tbo_horas: XB_ANU.tbo_horas,
      aeronave_horas_ref: XB_ANU.aeronave_horas_ref,
    });
    const svc = new PropellersService(service, armarAircraft(1381.6));
    await svc.update(HELICE, { turm_componente: 364 }, USUARIO);
    expect(ultimoPayload(escrituras, 'update').tso_base).toBe(364);
  });

  it('EDICIÓN: T.T. y T.U.R.M. juntos ⇒ base nueva + tso_base = T.U.R.M.', async () => {
    const { service, escrituras } = armarSupabase({
      id: HELICE,
      aeronave_id: AVION,
      horas_totales: 2600,
      tso_base: 250,
      tbo_horas: XB_ANU.tbo_horas,
      aeronave_horas_ref: XB_ANU.aeronave_horas_ref,
    });
    const svc = new PropellersService(service, armarAircraft(1381.6));
    await svc.update(
      HELICE,
      { horas_totales: 2708, turm_componente: 364 },
      USUARIO,
    );
    const patch = ultimoPayload(escrituras, 'update');
    expect(patch.horas_totales).toBe(2708);
    expect(patch.tso_base).toBe(364);
  });

  it('EDICIÓN de SOLO las horas totales: el TSO vivo se conserva (no se toca)', async () => {
    const { service, escrituras } = armarSupabase({
      id: HELICE,
      aeronave_id: AVION,
      horas_totales: 2700,
      tso_base: 364,
      tbo_horas: XB_ANU.tbo_horas,
      aeronave_horas_ref: XB_ANU.aeronave_horas_ref,
    });
    const svc = new PropellersService(service, armarAircraft(1381.6));
    await svc.update(HELICE, { horas_totales: 2708 }, USUARIO);
    expect(ultimoPayload(escrituras, 'update').tso_base).toBe(364);
  });

  it('T.U.R.M. > T.T. ⇒ 400 con explicación y SIN escribir nada', async () => {
    const { service, escrituras } = armarSupabase({
      id: HELICE,
      aeronave_id: AVION,
      horas_totales: 364,
      tso_base: null,
      aeronave_horas_ref: XB_ANU.aeronave_horas_ref,
    });
    const svc = new PropellersService(service, armarAircraft(1381.6));
    await expect(
      svc.update(HELICE, { turm_componente: 2708 }, USUARIO),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.update(HELICE, { turm_componente: 2708 }, USUARIO),
    ).rejects.toThrow(mensajeTurmSuperaTotales(2708, 364));
    expect(escrituras.filter((e) => e.op === 'update')).toHaveLength(0);
  });

  it('LA FICHA, con lo guardado bien: TSO 364, restantes 1636, vida 18.2 %', () => {
    const aircraft = armarAircraft(1381.6);
    const estado = aircraft.componenteEstado(
      {
        horas_totales: XB_ANU.horas_totales,
        tso_base: 364,
        turm: 0,
        tbo_horas: XB_ANU.tbo_horas,
        aeronave_horas_ref: XB_ANU.aeronave_horas_ref,
      },
      XB_ANU.aeronave_horas_ref,
      true,
    );
    expect(estado).toMatchObject({
      horas_actuales: 2708,
      horas_desde_overhaul: 364,
      // T.U.R.M. de la respuesta = TSO vivo (antes devolvía 2344).
      turm_componente: 364,
      tbo_restante: 1636,
      vida_usada_pct: 18.2,
    });
  });

  it('LA FICHA suma el delta del taco al TSO y al TSN (horas derivadas)', () => {
    const aircraft = armarAircraft(1391.6);
    const estado = aircraft.componenteEstado(
      {
        horas_totales: XB_ANU.horas_totales,
        tso_base: 364,
        turm: 0,
        tbo_horas: XB_ANU.tbo_horas,
        aeronave_horas_ref: XB_ANU.aeronave_horas_ref,
      },
      XB_ANU.aeronave_horas_ref + 10,
      true,
    );
    expect(estado).toMatchObject({
      horas_actuales: 2718,
      horas_desde_overhaul: 374,
      turm_componente: 374,
      tbo_restante: 1626,
    });
  });

  it('SIN overhaul registrado: turm_componente null y TSO = horas de vida', () => {
    const aircraft = armarAircraft(0);
    const estado = aircraft.componenteEstado(
      {
        horas_totales: 1630,
        tso_base: null,
        turm: 0,
        tbo_horas: 4000,
        aeronave_horas_ref: 1630,
      },
      1630,
      true,
    );
    expect(estado.turm_componente).toBeNull();
    expect(estado.horas_desde_overhaul).toBe(1630);
  });

  it('LO QUE NO CAMBIA: el respaldo LEGADO `turm` (taco del avión) sigue igual', () => {
    // N990GG: turm 4290.5 con taco 5543.9 ⇒ 1253.4 h desde overhaul.
    const aircraft = armarAircraft(5543.9);
    const estado = aircraft.componenteEstado(
      {
        horas_totales: 1274.5,
        tso_base: null,
        turm: 4290.5,
        tbo_horas: 2000,
        aeronave_horas_ref: 5543.9,
      },
      5543.9,
      true,
    );
    expect(estado.horas_desde_overhaul).toBe(1253.4);
    expect(estado.turm_componente).toBe(1253.4);
  });
});

/**
 * EL T.U.R.M. QUE SE TECLEA ES EL DE HOY (revisión adversaria 22-sep-2026).
 *
 * `tso_base` está ANCLADO en `aeronave_horas_ref` y el TSO que la ficha pinta
 * —y que el panel PRELLENA en el formulario— es el VIVO (`tso_base + delta`).
 * En el XB-ANU el delta es 0 y no se nota; en las dos hélices del **N4142R**
 * (ancla 4448.9, taco 5546.9) el delta es de **1,098 h**, así que guardar el
 * T.U.R.M. tal cual habría inflado el TSO en esas mismas horas: teclear 2,400
 * y que la ficha responda 3,498 es el MISMO desconcierto que reportó la
 * oficina, al revés.
 */
describe('T.U.R.M. anclado · hélice del N4142R (delta 1,098 h)', () => {
  const N4142R = {
    horas_totales: 4448.9,
    tso_base: 1307.9,
    aeronave_horas_ref: 4448.9,
    hobbs: 5546.9,
    tbo_horas: 2000,
  };
  const delta = N4142R.hobbs - N4142R.aeronave_horas_ref; // 1098

  const fila = () => ({
    id: HELICE,
    aeronave_id: AVION,
    horas_totales: N4142R.horas_totales,
    tso_base: N4142R.tso_base,
    tbo_horas: N4142R.tbo_horas,
    aeronave_horas_ref: N4142R.aeronave_horas_ref,
  });

  it('teclear el TSO de HOY guarda el tso_base del ANCLA (turm − delta)', async () => {
    const { service, escrituras } = armarSupabase(fila());
    const svc = new PropellersService(service, armarAircraft(N4142R.hobbs));
    await svc.update(HELICE, { turm_componente: 500 }, USUARIO);
    expect(ultimoPayload(escrituras, 'update').tso_base).toBe(500 - delta);
  });

  it('IDA Y VUELTA: lo que se teclea es lo que la ficha devuelve', async () => {
    const { service, escrituras } = armarSupabase(fila());
    const aircraft = armarAircraft(N4142R.hobbs);
    const svc = new PropellersService(service, aircraft);
    await svc.update(HELICE, { turm_componente: 500 }, USUARIO);
    const guardado = ultimoPayload(escrituras, 'update').tso_base as number;
    const estado = aircraft.componenteEstado(
      { ...fila(), tso_base: guardado, turm: 0 },
      N4142R.hobbs,
      true,
    );
    // Sin descontar el delta, esto daría 1598 y la barra saldría al 80 %.
    expect(estado.turm_componente).toBe(500);
    expect(estado.horas_desde_overhaul).toBe(500);
    expect(estado.tbo_restante).toBe(1500);
  });

  it('RE-GUARDAR sin cambios (el panel prellena el TSO vivo) no mueve el TSO', async () => {
    const { service, escrituras } = armarSupabase(fila());
    const aircraft = armarAircraft(N4142R.hobbs);
    const svc = new PropellersService(service, aircraft);
    // Lo que el formulario trae prellenado hoy = TSO vivo.
    const vivo = aircraft.componenteEstado(
      { ...fila(), turm: 0 },
      N4142R.hobbs,
      true,
    ).turm_componente as number;
    expect(vivo).toBe(2405.9);
    await svc.update(HELICE, { turm_componente: vivo }, USUARIO);
    // Se vuelve a escribir EXACTAMENTE el tso_base que ya estaba.
    expect(ultimoPayload(escrituras, 'update').tso_base).toBe(N4142R.tso_base);
  });

  it('un overhaul RECIENTE deja tso_base negativo a propósito (el vivo se recorta)', async () => {
    const { service, escrituras } = armarSupabase(fila());
    const aircraft = armarAircraft(N4142R.hobbs);
    const svc = new PropellersService(service, aircraft);
    await svc.update(HELICE, { turm_componente: 12 }, USUARIO);
    const guardado = ultimoPayload(escrituras, 'update').tso_base as number;
    expect(guardado).toBe(12 - delta);
    expect(
      aircraft.componenteEstado(
        { ...fila(), tso_base: guardado, turm: 0 },
        N4142R.hobbs,
        true,
      ).horas_desde_overhaul,
    ).toBe(12);
  });

  it('el techo del 400 es la vida VIVA (T.T. anclado + lo volado), no la base', async () => {
    const { service, escrituras } = armarSupabase(fila());
    const svc = new PropellersService(service, armarAircraft(N4142R.hobbs));
    // 5000 h desde el overhaul supera la base anclada (4448.9) pero NO la
    // vida viva (5546.9): es capturable y no puede rebotar.
    await svc.update(HELICE, { turm_componente: 5000 }, USUARIO);
    expect(ultimoPayload(escrituras, 'update').tso_base).toBe(5000 - delta);
    await expect(
      svc.update(HELICE, { turm_componente: 5600 }, USUARIO),
    ).rejects.toThrow(mensajeTurmSuperaTotales(5600, 5546.9));
  });

  it('cambiar también las horas totales RE-ANCLA: el T.U.R.M. entra tal cual', async () => {
    const { service, escrituras } = armarSupabase(fila());
    const svc = new PropellersService(service, armarAircraft(N4142R.hobbs));
    await svc.update(
      HELICE,
      { horas_totales: N4142R.hobbs, turm_componente: 500 },
      USUARIO,
    );
    const patch = ultimoPayload(escrituras, 'update');
    expect(patch.aeronave_horas_ref).toBe(N4142R.hobbs);
    expect(patch.tso_base).toBe(500);
  });
});

describe('T.U.R.M. = TSO · motores (mismo contrato que las hélices)', () => {
  const dtoMotor: CreateEngineDto = {
    aeronave_id: AVION,
    posicion: PosicionMotor.UNICO,
    numero_serie: '470851',
    tipo: TipoMotor.PISTON,
    horas_totales: 887.7,
    turm_componente: 429,
    tbo_horas: 1700,
  };

  it('ALTA: tso_base = T.U.R.M. capturado', async () => {
    const { service, escrituras } = armarSupabase({ id: 'motor-1' });
    const svc = new EnginesService(service, armarAircraft(1381.6));
    await svc.create(dtoMotor, USUARIO);
    expect(ultimoPayload(escrituras, 'insert').tso_base).toBe(429);
  });

  it('ALTA con T.U.R.M. > T.T. ⇒ 400 y no se inserta el motor', async () => {
    const { service, escrituras } = armarSupabase({ id: 'motor-1' });
    const svc = new EnginesService(service, armarAircraft(1381.6));
    await expect(
      svc.create({ ...dtoMotor, turm_componente: 1200 }, USUARIO),
    ).rejects.toThrow(mensajeTurmSuperaTotales(1200, 887.7));
    expect(escrituras.filter((e) => e.op === 'insert')).toHaveLength(0);
  });

  it('EDICIÓN: tso_base = T.U.R.M. capturado', async () => {
    const { service, escrituras } = armarSupabase({
      id: 'motor-1',
      aeronave_id: AVION,
      horas_totales: 887.7,
      tso_base: 458.7,
      tbo_horas: 1700,
      aeronave_horas_ref: 1381.6,
    });
    const svc = new EnginesService(service, armarAircraft(1381.6));
    await svc.update('motor-1', { turm_componente: 429 }, USUARIO);
    expect(ultimoPayload(escrituras, 'update').tso_base).toBe(429);
  });
});
