import { HttpException } from '@nestjs/common';
import {
  CONFIG_ACCESO_GASTOS_PERSONALES,
  CONFIG_ACCESO_NOMINA,
  ConfiguracionService,
} from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * ACCESO A GASTOS PERSONALES POR PERSONA (12-nov-2026, API 0.0.138,
 * invariante 133, SIN migración). Pedido de Dirección al ver la tarjeta
 * «Acceso a Nómina» con Mary encendida: «y venga otro para gastos
 * personales». MISMA mecánica que la lista `acceso_nomina` (una sola
 * implementación en el service), OTRA lista: `acceso_gastos_personales`.
 * Lo que aquí se congela además de la mecánica: las dos listas son
 * INDEPENDIENTES (estar en una no da la otra, guardar una no toca la otra) y
 * por su rol entran Dirección y Coordinación (Facturación, que sí lleva la
 * nómina, nunca tuvo los gastos personales).
 */
type Fila = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';
const PABLO = 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1';
const DIEGO = 'c4d0633d-a5e9-4764-8e54-03c7fb00f3b7';
const VILLALOBOS = 'ee3c5690-467c-481d-940f-f4c06010155f';
const ITZI = '5391362f-e8cc-4287-95ef-739911fbf0e5';
const MARY = 'e0b26729-1f02-4dc0-9c1a-e7192e638478';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000e';
const INACTIVO = '5efca0e1-3474-4857-aabf-0f99c9457903';
const FACTU = 'bbbbbbbb-0000-4000-8000-00000000fac7';
const COORD = 'cccccccc-0000-4000-8000-0000000c00d1';
const EXTERNO = 'dddddddd-0000-4000-8000-00000000e87e';
const SELLO = '2026-11-12T17:00:00.456+00:00';
const SELLO_NOMINA = '2026-11-12T16:43:10.000+00:00';

const usuario = (
  id: string,
  nombre: string,
  rol: string,
  extra: Fila = {},
): Fila => ({
  id,
  nombre,
  rol,
  estado: 'ACTIVO',
  es_piloto_externo: false,
  ...extra,
});

const USUARIOS: Fila[] = [
  usuario(ALE, 'Alejandro Canales', 'DIRECCION'),
  usuario(VILLALOBOS, 'Alejandro Villalobos', 'ADMIN'),
  usuario(COORD, 'Coordinación', 'COORDINADOR'),
  usuario(DIEGO, 'Diego Ramírez', 'DIRECCION'),
  usuario(FACTU, 'Facturación', 'FACTURACION'),
  usuario(ITZI, 'Itzi', 'ADMIN'),
  usuario(MARY, 'Mary Cruz', 'ADMIN'),
  usuario(PABLO, 'Pablo Canales', 'DIRECCION'),
  usuario(PILOTO, 'Piloto', 'PILOTO'),
  usuario(INACTIVO, 'Aero Charter Cancun S.A. de C.V.', 'ADMIN', {
    estado: 'INACTIVO',
  }),
  usuario(EXTERNO, 'Externo', 'ADMIN', { es_piloto_externo: true }),
];

interface FilaConfig {
  valor_json: unknown;
  updated_at: string;
  updated_by: string | null;
}

/**
 * PostgREST falso con las DOS filas (`acceso_nomina` y
 * `acceso_gastos_personales`) por separado: cada lectura, insert y update
 * resuelve contra la fila de SU clave, así que un cruce de listas en el
 * service se nota.
 */
function armar(m: {
  /** Fila `acceso_gastos_personales`; sin ella = nunca se ha guardado. */
  personales?: FilaConfig;
  /** Fila `acceso_nomina` (la otra lista). */
  nomina?: FilaConfig;
  /** La lectura de configuracion_sistema falla. */
  falla?: boolean;
  /** Otro guardado se cuela entre la lectura y la escritura (CAS / insert). */
  carrera?: boolean;
}) {
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const filas = new Map<string, FilaConfig>();
  if (m.personales) filas.set(CONFIG_ACCESO_GASTOS_PERSONALES, m.personales);
  if (m.nomina) filas.set(CONFIG_ACCESO_NOMINA, m.nomina);
  const from = (tabla: string) => {
    const ops: Op[] = [];
    llamadas.push({ tabla, ops });
    const q: Record<string, unknown> = {};
    for (const met of [
      'select',
      'eq',
      'neq',
      'in',
      'order',
      'limit',
      'update',
      'insert',
    ]) {
      q[met] = (...args: unknown[]) => {
        ops.push({ m: met, args });
        return q;
      };
    }
    const eq = (col: string) =>
      ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];
    const resolver = (unica: boolean) => {
      if (tabla === 'configuracion_sistema') {
        if (m.falla) return { data: null, error: { message: 'caída' } };
        const ins = ops.find((o) => o.m === 'insert');
        if (ins) {
          const v = ins.args[0] as Fila;
          const clave = v.clave as string;
          // Llave primaria `clave`: si otro la creó a la vez, 23505.
          if (m.carrera || filas.has(clave)) {
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key' },
            };
          }
          filas.set(clave, {
            valor_json: v.valor_json,
            updated_at: v.updated_at as string,
            updated_by: (v.updated_by as string | null) ?? null,
          });
          return { data: null, error: null };
        }
        const clave = eq('clave') as string | undefined;
        const upd = ops.find((o) => o.m === 'update');
        if (upd) {
          // CAS REAL: solo escribe si el sello sigue siendo el que se leyó.
          const actual = clave ? filas.get(clave) : undefined;
          const sello = eq('updated_at');
          if (
            m.carrera ||
            !clave ||
            !actual ||
            (sello !== undefined && sello !== actual.updated_at)
          ) {
            return { data: [], error: null };
          }
          const v = upd.args[0] as Fila;
          filas.set(clave, {
            valor_json: v.valor_json,
            updated_at: v.updated_at as string,
            updated_by: (v.updated_by as string | null) ?? null,
          });
          return { data: [{ clave }], error: null };
        }
        if (clave) {
          const f = filas.get(clave);
          return { data: f ? { clave, ...f } : null, error: null };
        }
        return { data: unica ? null : [], error: null };
      }
      if (tabla === 'usuario') {
        let lista = USUARIOS;
        for (const i of ops.filter((o) => o.m === 'in')) {
          const col = i.args[0] as string;
          const vals = i.args[1] as unknown[];
          lista = lista.filter((u) => vals.includes(u[col]));
        }
        for (const e of ops.filter((o) => o.m === 'eq')) {
          lista = lista.filter((u) => u[e.args[0] as string] === e.args[1]);
        }
        return { data: lista, error: null };
      }
      return { data: [], error: null };
    };
    q.maybeSingle = () => Promise.resolve(resolver(true));
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(resolver(false)).then(res);
    return q;
  };
  const svc = new ConfiguracionService({
    service: { from },
  } as unknown as SupabaseService);
  /** Lecturas de configuracion_sistema hechas por una clave concreta. */
  const lecturasDe = (clave: string) =>
    llamadas.filter(
      (l) =>
        l.tabla === 'configuracion_sistema' &&
        l.ops.some(
          (o) => o.m === 'eq' && o.args[0] === 'clave' && o.args[1] === clave,
        ),
    ).length;
  const escribio = () =>
    llamadas.some((l) =>
      l.ops.some((o) => o.m === 'update' || o.m === 'insert'),
    );
  const personales = () => filas.get(CONFIG_ACCESO_GASTOS_PERSONALES);
  const nomina = () => filas.get(CONFIG_ACCESO_NOMINA);
  return {
    svc,
    llamadas,
    filas,
    lecturasDe,
    escribio,
    personales,
    nomina,
  };
}

const fila = (
  ids: unknown[],
  por: string | null = ALE,
  sello = SELLO,
): FilaConfig => ({
  valor_json: ids,
  updated_at: sello,
  updated_by: por,
});
const direccion = (userId = ALE) => ({ userId, rol: 'DIRECCION' });
const admin = (userId = VILLALOBOS) => ({ userId, rol: 'ADMIN' });

async function errorDe(
  p: Promise<unknown>,
): Promise<{ status: number; body: Fila }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return {
      status: (e as HttpException).getStatus(),
      body: (e as HttpException).getResponse() as Fila,
    };
  }
  throw new Error('no lanzó');
}

describe('ConfiguracionService — acceso a Gastos personales por persona', () => {
  it('la clave es la del contrato y tiene sección propia (fuera del listado y del PATCH genérico)', async () => {
    expect(CONFIG_ACCESO_GASTOS_PERSONALES).toBe('acceso_gastos_personales');
    const { svc, llamadas, escribio } = armar({ personales: fila([MARY]) });
    await svc.list();
    const ops = llamadas.find((l) => l.tabla === 'configuracion_sistema')!.ops;
    expect(ops).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_ACCESO_GASTOS_PERSONALES],
    });
    // La de Nómina sigue excluida.
    expect(ops).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_ACCESO_NOMINA],
    });
    const { status, body } = await errorDe(
      svc.update(CONFIG_ACCESO_GASTOS_PERSONALES, { activa: false }, ALE),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('CLAVE_NO_EDITABLE_AQUI');
    expect(String(body.message)).toContain('Acceso a Gastos personales');
    expect(escribio()).toBe(false);
  });

  it('en la lista: Mary sí; Villalobos (también Administración) no', async () => {
    const { svc } = armar({ personales: fila([MARY]) });
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(true);
    expect(await svc.tieneAccesoGastosPersonales(VILLALOBOS)).toBe(false);
    expect(await svc.tieneAccesoGastosPersonales(null)).toBe(false);
    expect(await svc.tieneAccesoGastosPersonales(undefined)).toBe(false);
  });

  it('sin la fila (nunca se ha guardado) nadie de Administración entra: igual que el 0.0.137', async () => {
    const { svc } = armar({});
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(false);
    expect(await svc.entraAGastosPersonales(MARY, 'ADMIN')).toBe(false);
    const r = await svc.accesoGastosPersonales(direccion());
    expect(r.usuario_ids).toEqual([]);
    expect(r.usuarios).toEqual([]);
    expect(r.version).toBeNull();
    expect(r.actualizado_at).toBeNull();
    expect(r.actualizado_por_nombre).toBeNull();
  });

  it('las DOS listas son independientes: el acceso a Nómina no da los gastos personales, ni al revés', async () => {
    // Como en producción hoy: Mary tiene Nómina. Itzi, solo gastos personales.
    const { svc } = armar({
      nomina: fila([MARY], DIEGO, SELLO_NOMINA),
      personales: fila([ITZI]),
    });
    expect(await svc.tieneAccesoNomina(MARY)).toBe(true);
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(false);
    expect(await svc.tieneAccesoNomina(ITZI)).toBe(false);
    expect(await svc.tieneAccesoGastosPersonales(ITZI)).toBe(true);
    expect(await svc.permisosDe(MARY, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: true,
      gastos_personales: false,
    });
    expect(await svc.permisosDe(ITZI, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: false,
      gastos_personales: true,
    });
    expect(await svc.permisosDe(VILLALOBOS, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: false,
      gastos_personales: false,
    });
    // Cada GET trae SU lista y SU sello.
    const personales = await svc.accesoGastosPersonales(direccion());
    const nomina = await svc.accesoNomina(direccion());
    expect(personales.usuario_ids).toEqual([ITZI]);
    expect(personales.version).toBe(SELLO);
    expect(nomina.usuario_ids).toEqual([MARY]);
    expect(nomina.version).toBe(SELLO_NOMINA);
  });

  it('lista ilegible ⇒ falla CERRADO (sin acceso) y /me no revienta', async () => {
    const { svc } = armar({ personales: fila([MARY]), falla: true });
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(false);
    expect(
      await svc.tieneAccesoGastosPersonales(MARY, { usarCache: false }),
    ).toBe(false);
    expect(await svc.entraAGastosPersonales(MARY, 'ADMIN')).toBe(false);
    expect(await svc.permisosDe(MARY, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: false,
      gastos_personales: false,
    });
    // Quien entra por su rol no depende de la lista.
    expect(await svc.entraAGastosPersonales(ALE, 'DIRECCION')).toBe(true);
  });

  it('valor editado a mano con basura: solo cuentan los uuids', async () => {
    const { svc } = armar({
      personales: fila(['Mary', 42, MARY, MARY, null]),
    });
    expect((await svc.accesoGastosPersonales(direccion())).usuario_ids).toEqual(
      [MARY],
    );
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(true);
  });

  it('entraAGastosPersonales: Dirección y Coordinación por su rol SIN leer la lista; Administración solo por la lista', async () => {
    const { svc, lecturasDe } = armar({ personales: fila([MARY]) });
    for (const rol of ['DIRECCION', 'COORDINADOR']) {
      expect(await svc.entraAGastosPersonales(VILLALOBOS, rol)).toBe(true);
    }
    expect(lecturasDe(CONFIG_ACCESO_GASTOS_PERSONALES)).toBe(0);
    expect(await svc.entraAGastosPersonales(MARY, 'ADMIN')).toBe(true);
    expect(await svc.entraAGastosPersonales(VILLALOBOS, 'ADMIN')).toBe(false);
    // …y para decidirlo NUNCA se leyó la lista de Nómina.
    expect(lecturasDe(CONFIG_ACCESO_NOMINA)).toBe(0);
  });

  it('la lista solo le abre la puerta a Administración: Facturación (que sí lleva la nómina) y los demás roles NO entran ni estando en ella (y ni se lee)', async () => {
    const { svc, lecturasDe } = armar({
      personales: fila([MARY, PILOTO, FACTU]),
    });
    for (const rol of [
      'FACTURACION',
      'PILOTO',
      'SOCIO',
      'ANALISTA',
      'MECANICO',
      'VISITANTE',
      null,
      undefined,
      '',
    ]) {
      expect(await svc.entraAGastosPersonales(MARY, rol)).toBe(false);
    }
    expect(lecturasDe(CONFIG_ACCESO_GASTOS_PERSONALES)).toBe(0);
    // /me de Facturación: nómina sí (por su rol), gastos personales no.
    expect(await svc.permisosDe(FACTU, 'FACTURACION')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: true,
      gastos_personales: false,
    });
    expect((await svc.permisosDe(COORD, 'COORDINADOR')).gastos_personales).toBe(
      true,
    );
    expect((await svc.permisosDe(ALE, 'DIRECCION')).gastos_personales).toBe(
      true,
    );
    expect((await svc.permisosDe(PILOTO, 'PILOTO')).gastos_personales).toBe(
      false,
    );
    expect((await svc.permisosDe(null, null)).gastos_personales).toBe(false);
  });

  it('/me usa el caché de 60 s; los candados de Gastos (usarCache: false) leen SIEMPRE la lista vigente', async () => {
    const { svc, filas, lecturasDe } = armar({ personales: fila([MARY]) });
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(true);
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(true);
    expect(lecturasDe(CONFIG_ACCESO_GASTOS_PERSONALES)).toBe(1);
    // Alguien la cambia por fuera de este proceso (otra réplica, SQL).
    filas.set(CONFIG_ACCESO_GASTOS_PERSONALES, fila([]));
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(true); // caché
    expect(
      await svc.tieneAccesoGastosPersonales(MARY, { usarCache: false }),
    ).toBe(false);
    // …y esa lectura fresca deja el caché al día.
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(false);
  });

  it('GET: lista, nombres, candidatos (Administración ACTIVA), quién entra por su rol (Dirección y Coordinación, SIN Facturación), quién puede cambiarla y el último cambio', async () => {
    const { svc } = armar({ personales: fila([MARY, INACTIVO], PABLO) });
    const r = await svc.accesoGastosPersonales(direccion(DIEGO));
    expect(r.usuario_ids).toEqual([MARY, INACTIVO]);
    expect(r.usuarios).toEqual([
      { id: MARY, nombre: 'Mary Cruz' },
      { id: INACTIVO, nombre: 'Aero Charter Cancun S.A. de C.V.' },
    ]);
    // Solo Administración ACTIVA y de oficina: los mismos que en Nómina.
    expect(r.candidatos).toEqual([
      { id: VILLALOBOS, nombre: 'Alejandro Villalobos', rol: 'ADMIN' },
      { id: ITZI, nombre: 'Itzi', rol: 'ADMIN' },
      { id: MARY, nombre: 'Mary Cruz', rol: 'ADMIN' },
    ]);
    expect(r.por_rol.map((u) => [u.nombre, u.rol])).toEqual([
      ['Alejandro Canales', 'DIRECCION'],
      ['Coordinación', 'COORDINADOR'],
      ['Diego Ramírez', 'DIRECCION'],
      ['Pablo Canales', 'DIRECCION'],
    ]);
    expect(r.puede_modificar).toBe(true);
    expect(r.version).toBe(SELLO);
    expect(r.actualizado_at).toBe(SELLO);
    expect(r.actualizado_por_nombre).toBe('Pablo Canales');
    // Administración la LEE pero no la cambia.
    expect((await svc.accesoGastosPersonales(admin())).puede_modificar).toBe(
      false,
    );
  });

  it('PUT por quien no es de Dirección ⇒ 403 SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES (y no escribe), aunque esté en la lista', async () => {
    const { svc, escribio, personales } = armar({ personales: fila([MARY]) });
    for (const actor of [
      admin(VILLALOBOS),
      admin(MARY),
      { userId: FACTU, rol: 'FACTURACION' },
      { userId: COORD, rol: 'COORDINADOR' },
      { userId: PILOTO, rol: undefined },
    ]) {
      const { status, body } = await errorDe(
        svc.setAccesoGastosPersonales([MARY, VILLALOBOS], actor),
      );
      expect(status).toBe(403);
      expect(body.error).toBe('SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES');
      expect(body.message).toBe(
        'Solo Dirección puede cambiar quién entra a Gastos personales.',
      );
    }
    expect(escribio()).toBe(false);
    expect(personales()?.valor_json).toEqual([MARY]);
  });

  it('PUT con alguien que no es Administración ACTIVA ⇒ 400 USUARIOS_INVALIDOS con los ids (y no escribe)', async () => {
    const { svc, escribio } = armar({ personales: fila([MARY]) });
    const { status, body } = await errorDe(
      svc.setAccesoGastosPersonales(
        [MARY, ALE, FACTU, COORD, PILOTO, INACTIVO, EXTERNO],
        direccion(),
      ),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('USUARIOS_INVALIDOS');
    expect(body.details).toEqual({
      ids: [ALE, FACTU, COORD, PILOTO, INACTIVO, EXTERNO],
    });
    expect(body.message).toBe(
      'Solo se le puede dar acceso a Gastos personales a usuarios ACTIVOS de Administración (Dirección y Coordinación ya entran por su rol).',
    );
    expect(escribio()).toBe(false);
  });

  it('primer PUT (sin fila): CREA la fila de gastos personales con su descripción, quién y cuándo; aplica al instante y NO toca la de Nómina', async () => {
    const { svc, llamadas, personales, nomina } = armar({
      nomina: fila([MARY], DIEGO, SELLO_NOMINA),
    });
    // Calienta el caché de /me con «nadie».
    expect(await svc.permisosDe(ITZI, 'ADMIN')).toMatchObject({
      gastos_personales: false,
    });
    const r = await svc.setAccesoGastosPersonales(
      [ITZI, ITZI],
      direccion(DIEGO),
      null,
    );
    const ins = llamadas.flatMap((l) => l.ops).find((o) => o.m === 'insert')!
      .args[0] as Fila;
    expect(ins.clave).toBe(CONFIG_ACCESO_GASTOS_PERSONALES);
    expect(ins.activa).toBe(true);
    expect(String(ins.descripcion)).toContain('Gastos personales');
    expect(String(ins.descripcion)).not.toContain('Nómina');
    expect(ins.valor_json).toEqual([ITZI]);
    expect(ins.updated_by).toBe(DIEGO);
    expect(personales()?.valor_json).toEqual([ITZI]);
    expect(r.usuario_ids).toEqual([ITZI]);
    expect(r.usuarios).toEqual([{ id: ITZI, nombre: 'Itzi' }]);
    expect(r.actualizado_por_nombre).toBe('Diego Ramírez');
    expect(r.version).toBe(personales()?.updated_at);
    // Sin esperar los 60 s del caché.
    expect(await svc.permisosDe(ITZI, 'ADMIN')).toMatchObject({
      gastos_personales: true,
      nomina: false,
    });
    // La lista de Nómina quedó EXACTAMENTE como estaba (lista y sello).
    expect(nomina()).toEqual(fila([MARY], DIEGO, SELLO_NOMINA));
    expect(await svc.permisosDe(MARY, 'ADMIN')).toMatchObject({
      nomina: true,
      gastos_personales: false,
    });
  });

  it('PUT con la fila: UPDATE con CAS sobre updated_at de SU clave, sin repetidos; quitar el acceso aplica al instante', async () => {
    const { svc, llamadas, personales, nomina } = armar({
      personales: fila([MARY]),
      nomina: fila([MARY], DIEGO, SELLO_NOMINA),
    });
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(true);
    const r = await svc.setAccesoGastosPersonales(
      [ITZI, VILLALOBOS, ITZI],
      direccion(PABLO),
      SELLO,
    );
    const upd = llamadas.find((l) => l.ops.some((o) => o.m === 'update'))!;
    expect(upd.ops).toContainEqual({ m: 'eq', args: ['updated_at', SELLO] });
    expect(upd.ops).toContainEqual({
      m: 'eq',
      args: ['clave', CONFIG_ACCESO_GASTOS_PERSONALES],
    });
    const escrito = upd.ops.find((o) => o.m === 'update')!.args[0] as Fila;
    expect(escrito.valor_json).toEqual([ITZI, VILLALOBOS]);
    expect(escrito.updated_by).toBe(PABLO);
    // El UPDATE no toca `activa` ni la descripción.
    expect(Object.keys(escrito).sort()).toEqual([
      'updated_at',
      'updated_by',
      'valor_json',
    ]);
    expect(personales()?.valor_json).toEqual([ITZI, VILLALOBOS]);
    expect(r.usuario_ids).toEqual([ITZI, VILLALOBOS]);
    expect(r.actualizado_por_nombre).toBe('Pablo Canales');
    // A Mary se le quitaron los gastos personales; su Nómina sigue.
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(false);
    expect(
      await svc.entraAGastosPersonales(MARY, 'ADMIN', { usarCache: false }),
    ).toBe(false);
    expect(await svc.tieneAccesoGastosPersonales(ITZI)).toBe(true);
    expect(nomina()).toEqual(fila([MARY], DIEGO, SELLO_NOMINA));
    expect(await svc.tieneAccesoNomina(MARY, { usarCache: false })).toBe(true);
  });

  it('guardar la lista de Nómina no mueve el sello de la de gastos personales (un guardado ajeno no provoca un 409 aquí)', async () => {
    const { svc, personales } = armar({
      personales: fila([ITZI]),
      nomina: fila([MARY], DIEGO, SELLO_NOMINA),
    });
    await svc.setAccesoNomina([MARY, ITZI], direccion(PABLO), SELLO_NOMINA);
    expect(personales()).toEqual(fila([ITZI]));
    // La pantalla de gastos personales (sello de antes) todavía guarda.
    const r = await svc.setAccesoGastosPersonales([], direccion(ALE), SELLO);
    expect(r.usuario_ids).toEqual([]);
  });

  it('PUT con la lista VACÍA es válido: nadie de Administración entra', async () => {
    const { svc, personales } = armar({ personales: fila([MARY, ITZI]) });
    const r = await svc.setAccesoGastosPersonales([], direccion(), SELLO);
    expect(personales()?.valor_json).toEqual([]);
    expect(r.usuario_ids).toEqual([]);
    expect(await svc.tieneAccesoGastosPersonales(MARY)).toBe(false);
  });

  it('guardar desde una pantalla VIEJA (otro de Dirección ya cambió la lista) ⇒ 409 ACCESO_GASTOS_PERSONALES_CAMBIO sin escribir: no le devuelve el acceso a quien se lo acaban de quitar', async () => {
    // Pablo acaba de quitar a Mary; la pantalla de Ale todavía la traía.
    const { svc, escribio, personales } = armar({
      personales: fila([], PABLO),
    });
    const { status, body } = await errorDe(
      svc.setAccesoGastosPersonales(
        [MARY, ITZI],
        direccion(ALE),
        '2026-11-12T16:00:00.000+00:00',
      ),
    );
    expect(status).toBe(409);
    expect(body.error).toBe('ACCESO_GASTOS_PERSONALES_CAMBIO');
    expect(body.message).toBe(
      'Alguien más cambió quién entra a Gastos personales mientras lo editabas. Recarga y vuelve a intentar.',
    );
    expect(escribio()).toBe(false);
    expect(personales()?.valor_json).toEqual([]);
    // La pantalla creía que nunca se había guardado y ya existe la fila.
    expect(
      (
        await errorDe(
          svc.setAccesoGastosPersonales([MARY], direccion(ALE), null),
        )
      ).body.error,
    ).toBe('ACCESO_GASTOS_PERSONALES_CAMBIO');
    // …y al revés: traía un sello pero la fila no existe (aunque la de
    // Nómina sí exista con ESE mismo sello: es otra lista).
    const sinFila = armar({ nomina: fila([MARY], DIEGO, SELLO) });
    expect(
      (
        await errorDe(
          sinFila.svc.setAccesoGastosPersonales([MARY], direccion(ALE), SELLO),
        )
      ).body.error,
    ).toBe('ACCESO_GASTOS_PERSONALES_CAMBIO');
    expect(sinFila.escribio()).toBe(false);
  });

  it('el sello se compara por INSTANTE («Z» = «+00:00»); sin `version` no hay comprobación de pantalla', async () => {
    const a = armar({ personales: fila([MARY]) });
    await a.svc.setAccesoGastosPersonales(
      [ITZI],
      direccion(),
      '2026-11-12T17:00:00.456Z',
    );
    expect(a.personales()?.valor_json).toEqual([ITZI]);
    const b = armar({ personales: fila([MARY]) });
    await b.svc.setAccesoGastosPersonales([ITZI], direccion());
    expect(b.personales()?.valor_json).toEqual([ITZI]);
  });

  it('dos guardados a la vez: el CAS (o el insert) pierde ⇒ 409 ACCESO_GASTOS_PERSONALES_CAMBIO', async () => {
    const conFila = armar({ personales: fila([MARY]), carrera: true });
    const r1 = await errorDe(
      conFila.svc.setAccesoGastosPersonales([ITZI], direccion(), SELLO),
    );
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('ACCESO_GASTOS_PERSONALES_CAMBIO');
    expect(conFila.personales()?.valor_json).toEqual([MARY]);
    const sinFila = armar({ carrera: true });
    const r2 = await errorDe(
      sinFila.svc.setAccesoGastosPersonales([ITZI], direccion(), null),
    );
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('ACCESO_GASTOS_PERSONALES_CAMBIO');
    expect(sinFila.personales()).toBeUndefined();
  });
});
