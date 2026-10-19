// PROPIETARIOS DEL AVIÓN (19-oct-2026, API 0.0.97, invariante 95): quitar
// con el ÚLTIMO día (hoy Cancún por omisión, no el día UTC del servidor),
// borrar la fila que se agregó por error, corregir persona y fechas, y
// agregar un propietario que SUSTITUYE a otro (el sustituido termina el día
// anterior; todo se valida antes de escribir).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AircraftService } from './aircraft.service';
import {
  CODIGO_PROPIETARIO,
  MENSAJE_FECHA_INVALIDA,
  MENSAJE_PROPIETARIO_NO_EXISTE,
  MENSAJE_SUSTITUYE_INVALIDO,
  mensajeHastaAntesDelInicio,
  mensajeSumaExcede,
  mensajeSustituyeAntesDelInicio,
} from './propietarios.util';
import {
  supabaseGrabador,
  type ConsultaGrabada,
} from '../../common/inicio-oficial.fixture-spec';

const AVION = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTRO_AVION = 'aaaaaaaa-0000-4000-8000-000000000002';
const HERNAN = 'bbbbbbbb-0000-4000-8000-000000000001';
const ALEJANDRO = 'bbbbbbbb-0000-4000-8000-000000000002';
const U_HERNAN = 'cccccccc-0000-4000-8000-000000000001';
const U_ALEJANDRO = 'cccccccc-0000-4000-8000-000000000002';

type Fila = Record<string, unknown> & { id: string };

/** El caso real de XA-VGV (19-oct-2026): dos dueños al 100 % encimados. */
const FILAS: Fila[] = [
  {
    id: HERNAN,
    aeronave_id: AVION,
    socio_id: U_HERNAN,
    porcentaje: '100.000',
    vigente_desde: '2020-01-01',
    vigente_hasta: null,
    notas: 'Regimen temporal',
    usuario: { nombre: 'Hernan Garza' },
  },
  {
    id: ALEJANDRO,
    aeronave_id: AVION,
    socio_id: U_ALEJANDRO,
    porcentaje: '100.000',
    vigente_desde: '2026-08-18',
    vigente_hasta: null,
    notas: null,
    usuario: { nombre: 'Alejandro Canales' },
  },
];

/** Solo Hernan (abierto al 100 %): sin nadie encimado. */
const SOLO_HERNAN: Fila[] = [FILAS[0]];
/** Hernan ya cerrado el 17-ago y Alejandro desde el 18-ago: el caso bien hecho. */
const RELEVO_HECHO: Fila[] = [
  { ...FILAS[0], vigente_hasta: '2026-08-17' },
  FILAS[1],
];

const hoyCancun = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });

function armar(filas: Fila[] = FILAS) {
  const g = supabaseGrabador((tabla, ops) => {
    if (tabla !== 'aeronave_socio') return undefined;
    const eqId = ops.find((o) => o.m === 'eq' && o.args[0] === 'id');
    const eqAvion = ops.find(
      (o) => o.m === 'eq' && o.args[0] === 'aeronave_id',
    );
    const enIds = ops.find((o) => o.m === 'in' && o.args[0] === 'id');
    const insert = ops.find((o) => o.m === 'insert');
    const update = ops.find((o) => o.m === 'update');
    if (insert) {
      return {
        data: [{ id: 'nuevo', ...(insert.args[0] as object) }],
        error: null,
      };
    }
    if (update) {
      const f = filas.find((x) => x.id === eqId?.args[1]);
      return {
        data: f ? [{ ...f, ...(update.args[0] as object) }] : [],
        error: null,
      };
    }
    if (ops.some((o) => o.m === 'delete')) return { data: [], error: null };
    if (enIds) {
      const ids = enIds.args[1] as string[];
      return { data: filas.filter((f) => ids.includes(f.id)), error: null };
    }
    if (eqId) {
      return { data: filas.filter((f) => f.id === eqId.args[1]), error: null };
    }
    if (eqAvion) {
      return {
        data: filas.filter((f) => f.aeronave_id === eqAvion.args[1]),
        error: null,
      };
    }
    return { data: filas, error: null };
  });
  const service = new AircraftService(g.supabase, {} as never, {} as never);
  jest.spyOn(service, 'findById').mockResolvedValue({} as never);
  const escrituras = (m: 'update' | 'insert' | 'delete'): ConsultaGrabada[] =>
    g.de('aeronave_socio').filter((c) => c.ops.some((o) => o.m === m));
  const patchDe = (c: ConsultaGrabada) =>
    c.ops.find((o) => o.m === 'update')!.args[0] as Record<string, unknown>;
  return { service, escrituras, patchDe, ...g };
}

async function rechazo(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { constructor: unknown; getResponse(): unknown };
  }
  throw new Error('no rechazó');
}

describe('closeOwner — «Quitar» con el último día', () => {
  it('sin fecha ⇒ HOY en Cancún (no el día UTC del servidor)', async () => {
    const { service, escrituras, patchDe, lleva } = armar();
    await service.closeOwner(HERNAN, undefined, 'u-1');
    const [u] = escrituras('update');
    expect(lleva(u, 'eq', 'id', HERNAN)).toBe(true);
    expect(patchDe(u)).toEqual({
      vigente_hasta: hoyCancun(),
      updated_by: 'u-1',
    });
  });

  it('con fecha ⇒ ese día (Hernan termina el 17-ago, el día antes de Alejandro)', async () => {
    const { service, escrituras, patchDe } = armar();
    const r = (await service.closeOwner(HERNAN, '2026-08-17', 'u-1')) as {
      vigente_hasta: string;
    };
    expect(patchDe(escrituras('update')[0]).vigente_hasta).toBe('2026-08-17');
    expect(r.vigente_hasta).toBe('2026-08-17');
  });

  it('un último día anterior al primero ⇒ 400 con el nombre y la salida, SIN escribir', async () => {
    const { service, escrituras } = armar();
    const e = await rechazo(service.closeOwner(ALEJANDRO, '2026-08-17', 'u-1'));
    expect(e.constructor).toBe(BadRequestException);
    expect(e.getResponse()).toEqual({
      message: mensajeHastaAntesDelInicio(
        'Alejandro Canales',
        '2026-08-18',
        '2026-08-17',
      ),
      error: CODIGO_PROPIETARIO.VIGENCIA_INVALIDA,
    });
    expect(escrituras('update')).toHaveLength(0);
  });

  it('el mismo primer día SÍ se acepta (régimen de un día)', async () => {
    const { service, escrituras } = armar();
    await service.closeOwner(ALEJANDRO, '2026-08-18', 'u-1');
    expect(escrituras('update')).toHaveLength(1);
  });

  it('una fecha que no es día ⇒ 400 FECHA_INVALIDA sin tocar la base', async () => {
    const { service, consultas } = armar();
    const e = await rechazo(service.closeOwner(HERNAN, '17/08/2026', 'u-1'));
    expect(e.constructor).toBe(BadRequestException);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_FECHA_INVALIDA,
      error: CODIGO_PROPIETARIO.FECHA_INVALIDA,
    });
    expect(consultas).toHaveLength(0);
  });

  it('un propietario que ya no existe ⇒ 404 con código', async () => {
    const { service, escrituras } = armar();
    const e = await rechazo(
      service.closeOwner(
        'dddddddd-0000-4000-8000-000000000009',
        undefined,
        'u-1',
      ),
    );
    expect(e.constructor).toBe(NotFoundException);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_PROPIETARIO_NO_EXISTE,
      error: CODIGO_PROPIETARIO.NO_EXISTE,
    });
    expect(escrituras('update')).toHaveLength(0);
  });
});

describe('deleteOwner — «Se agregó por error»', () => {
  it('borra la fila por id y devuelve quién era', async () => {
    const { service, escrituras, lleva } = armar();
    const r = await service.deleteOwner(ALEJANDRO);
    const [d] = escrituras('delete');
    expect(lleva(d, 'eq', 'id', ALEJANDRO)).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.eliminado.nombre).toBe('Alejandro Canales');
    expect(r.eliminado.vigente_desde).toBe('2026-08-18');
  });

  it('inexistente ⇒ 404 y ningún delete', async () => {
    const { service, escrituras } = armar();
    const e = await rechazo(
      service.deleteOwner('dddddddd-0000-4000-8000-000000000009'),
    );
    expect(e.constructor).toBe(NotFoundException);
    expect(escrituras('delete')).toHaveLength(0);
  });
});

describe('updateOwner — corregir persona, porcentaje y fechas', () => {
  it('acepta socio_id y vigente_desde (antes el DTO los rechazaba) y null reabre', async () => {
    const { service, escrituras, patchDe } = armar(SOLO_HERNAN);
    await service.updateOwner(
      HERNAN,
      {
        socio_id: U_ALEJANDRO,
        porcentaje: 70,
        vigente_desde: new Date('2026-01-01'),
        vigente_hasta: null,
        notas: 'corregido',
      },
      'u-2',
    );
    expect(patchDe(escrituras('update')[0])).toEqual({
      updated_by: 'u-2',
      socio_id: U_ALEJANDRO,
      porcentaje: 70,
      vigente_desde: '2026-01-01',
      vigente_hasta: null,
      notas: 'corregido',
    });
  });

  it('solo el porcentaje ⇒ el patch no toca las fechas ni la persona', async () => {
    const { service, escrituras, patchDe } = armar(SOLO_HERNAN);
    await service.updateOwner(HERNAN, { porcentaje: 30 }, 'u-2');
    expect(patchDe(escrituras('update')[0])).toEqual({
      updated_by: 'u-2',
      porcentaje: 30,
    });
  });

  it('un último día anterior al primer día (vigente o nuevo) ⇒ 400 sin escribir', async () => {
    const { service, escrituras } = armar();
    const e = await rechazo(
      service.updateOwner(
        ALEJANDRO,
        { vigente_hasta: new Date('2026-08-17') },
        'u-2',
      ),
    );
    expect(e.constructor).toBe(BadRequestException);
    expect(e.getResponse()).toEqual({
      message: mensajeHastaAntesDelInicio(
        'Alejandro Canales',
        '2026-08-18',
        '2026-08-17',
      ),
      error: CODIGO_PROPIETARIO.VIGENCIA_INVALIDA,
    });
    // Mover el primer día DESPUÉS del último que ya tiene, igual.
    const e2 = await rechazo(
      service.updateOwner(
        HERNAN,
        {
          vigente_desde: new Date('2026-09-01'),
          vigente_hasta: new Date('2026-08-17'),
        },
        'u-2',
      ),
    );
    expect(e2.constructor).toBe(BadRequestException);
    expect(escrituras('update')).toHaveLength(0);
  });

  it('más del 100 % en un día ⇒ 400 SUMA_EXCEDE con quiénes, sin escribir', async () => {
    // Hernan 100 abierto + Alejandro 100 desde el 18-ago (el caso de prod):
    // bajar a Alejandro a 50 sigue encimando (150).
    const { service, escrituras } = armar();
    const e = await rechazo(
      service.updateOwner(ALEJANDRO, { porcentaje: 50 }, 'u-2'),
    );
    expect(e.constructor).toBe(BadRequestException);
    expect(e.getResponse()).toMatchObject({
      error: CODIGO_PROPIETARIO.SUMA_EXCEDE,
      details: { dia: '2026-08-18', suma: 150 },
    });
    expect((e.getResponse() as { message: string }).message).toBe(
      mensajeSumaExcede({
        dia: '2026-08-18',
        suma: 150,
        propietarios: [
          { id: HERNAN, nombre: 'Hernan Garza', porcentaje: 100 },
          { id: ALEJANDRO, nombre: 'Alejandro Canales', porcentaje: 50 },
        ],
      }),
    );
    expect(escrituras('update')).toHaveLength(0);
    // Cerrar a Hernan el 17-ago (lo que arregla el caso) SÍ pasa.
    const { service: s2, escrituras: e2 } = armar();
    await s2.updateOwner(
      HERNAN,
      { vigente_hasta: new Date('2026-08-17') },
      'u-2',
    );
    expect(e2('update')).toHaveLength(1);
    // Solo las notas no consultan la suma.
    const { service: s3, consultas } = armar();
    await s3.updateOwner(ALEJANDRO, { notas: 'x' }, 'u-2');
    expect(
      consultas.filter((c) =>
        c.ops.some((o) => o.m === 'eq' && o.args[0] === 'aeronave_id'),
      ),
    ).toHaveLength(0);
  });

  it('patch vacío ⇒ 400; inexistente ⇒ 404', async () => {
    const { service } = armar();
    expect(
      (await rechazo(service.updateOwner(HERNAN, {}, 'u-2'))).constructor,
    ).toBe(BadRequestException);
    const e = await rechazo(
      service.updateOwner(
        'dddddddd-0000-4000-8000-000000000009',
        { porcentaje: 1 },
        'u-2',
      ),
    );
    expect(e.constructor).toBe(NotFoundException);
  });
});

describe('createOwner — agregar sustituyendo (el caso XA-VGV bien hecho)', () => {
  const soloHernan = SOLO_HERNAN;
  const alta = {
    socio_id: U_ALEJANDRO,
    porcentaje: 100,
    vigente_desde: new Date('2026-08-18'),
  };

  it('Alejandro entra el 18-ago sustituyendo a Hernan ⇒ insert y luego Hernan termina el 17-ago', async () => {
    const { service, escrituras, patchDe, lleva, consultas } =
      armar(soloHernan);
    const r = (await service.createOwner(
      AVION,
      { ...alta, sustituye_a: [HERNAN] },
      'u-1',
    )) as { id: string; sustituidos: { id: string; vigente_hasta: string }[] };
    expect(r.sustituidos).toEqual([
      { id: HERNAN, vigente_hasta: '2026-08-17' },
    ]);
    const [ins] = escrituras('insert');
    expect(ins.ops.find((o) => o.m === 'insert')!.args[0]).toMatchObject({
      aeronave_id: AVION,
      socio_id: U_ALEJANDRO,
      porcentaje: 100,
      vigente_desde: '2026-08-18',
      created_by: 'u-1',
    });
    const [upd] = escrituras('update');
    expect(lleva(upd, 'eq', 'id', HERNAN)).toBe(true);
    expect(patchDe(upd)).toEqual({
      vigente_hasta: '2026-08-17',
      updated_by: 'u-1',
    });
    // Orden: se LEE a los sustituidos, se lee el avión para la suma por día,
    // se inserta el nuevo y al final se cierra.
    const orden = consultas
      .filter((c) => c.tabla === 'aeronave_socio')
      .map(
        (c) =>
          c.ops.find((o) => ['in', 'insert', 'update'].includes(o.m))?.m ??
          'lectura',
      );
    expect(orden).toEqual(['in', 'lectura', 'insert', 'update']);
  });

  it('sin sustituye_a es el alta de siempre (sin leer ni cerrar a nadie)', async () => {
    const { service, escrituras, consultas } = armar([RELEVO_HECHO[0]]);
    const r = (await service.createOwner(AVION, alta, 'u-1')) as {
      sustituidos: unknown[];
    };
    expect(r.sustituidos).toEqual([]);
    expect(escrituras('insert')).toHaveLength(1);
    expect(escrituras('update')).toHaveLength(0);
    expect(
      consultas.filter((c) => c.ops.some((o) => o.m === 'in')),
    ).toHaveLength(0);
  });

  it('100 + 100 sin sustituir a nadie ⇒ 400 SUMA_EXCEDE y NO se inserta (la prueba de la oficina)', async () => {
    const { service, escrituras } = armar(soloHernan);
    const e = await rechazo(service.createOwner(AVION, alta, 'u-1'));
    expect(e.constructor).toBe(BadRequestException);
    expect(e.getResponse()).toMatchObject({
      error: CODIGO_PROPIETARIO.SUMA_EXCEDE,
      details: { dia: '2026-08-18', suma: 200 },
    });
    expect((e.getResponse() as { message: string }).message).toContain(
      'Hernan Garza 100 % + El nuevo propietario 100 %',
    );
    expect(escrituras('insert')).toHaveLength(0);
    // Con 30 % cabe (Hernan 100 no, pero si Hernan fuera 70): el límite es la suma.
    const { service: s2, escrituras: e2 } = armar([
      { ...FILAS[0], porcentaje: '70.000' },
    ]);
    await s2.createOwner(AVION, { ...alta, porcentaje: 30 }, 'u-1');
    expect(e2('insert')).toHaveLength(1);
  });

  it('un sustituido que empezó DESPUÉS del día anterior ⇒ 400 y NO se inserta nada', async () => {
    const { service, escrituras } = armar();
    const e = await rechazo(
      service.createOwner(
        AVION,
        {
          ...alta,
          vigente_desde: new Date('2026-08-18'),
          sustituye_a: [ALEJANDRO],
        },
        'u-1',
      ),
    );
    expect(e.constructor).toBe(BadRequestException);
    expect(e.getResponse()).toEqual({
      message: mensajeSustituyeAntesDelInicio(
        'Alejandro Canales',
        '2026-08-18',
        '2026-08-18',
      ),
      error: CODIGO_PROPIETARIO.VIGENCIA_INVALIDA,
    });
    expect(escrituras('insert')).toHaveLength(0);
    expect(escrituras('update')).toHaveLength(0);
  });

  it('un id de otro avión (o inexistente) ⇒ 400 SUSTITUYE_INVALIDO sin insertar', async () => {
    const ajeno = [{ ...FILAS[0], aeronave_id: OTRO_AVION }];
    const { service, escrituras } = armar(ajeno);
    const e = await rechazo(
      service.createOwner(AVION, { ...alta, sustituye_a: [HERNAN] }, 'u-1'),
    );
    expect(e.getResponse()).toEqual({
      message: MENSAJE_SUSTITUYE_INVALIDO,
      error: CODIGO_PROPIETARIO.SUSTITUYE_INVALIDO,
    });
    expect(escrituras('insert')).toHaveLength(0);
  });

  it('vigente_hasta anterior a vigente_desde en el alta ⇒ 400 sin insertar', async () => {
    const { service, escrituras } = armar(soloHernan);
    const e = await rechazo(
      service.createOwner(
        AVION,
        { ...alta, vigente_hasta: new Date('2026-08-01') },
        'u-1',
      ),
    );
    expect(e.constructor).toBe(BadRequestException);
    expect(escrituras('insert')).toHaveLength(0);
  });
});
