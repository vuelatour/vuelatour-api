import { HttpException } from '@nestjs/common';
import {
  CONFIG_ACCESO_NOMINA,
  CONFIG_EDITORES_COTIZACION_COBRADA,
  ConfiguracionService,
} from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * ACCESO A NÓMINA POR PERSONA (12-nov-2026, API 0.0.137, invariante 132, SIN
 * migración). Pedido de Dirección: «poder habilitar o deshabilitar a algunos
 * usuarios el módulo de nómina … le acaban de autorizar el acceso a Mary,
 * pero no sé si es para siempre o temporal, mejor poder controlarlo desde
 * configuración». En prod TODA la oficina es ADMIN (Administración) o
 * DIRECCION: el acceso es por PERSONA. Reglas de la lista `acceso_nomina`:
 * solo Dirección la cambia (403), solo admite Administración ACTIVA (400),
 * puede quedar vacía, la fila nace en el primer PUT y un guardado desde una
 * pantalla vieja no pisa lo que otro cambió (409).
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
const SELLO = '2026-11-12T15:00:00.123+00:00';

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

function armar(m: {
  /** Fila `acceso_nomina`; `undefined` = NO existe (nunca se ha guardado). */
  fila?: FilaConfig;
  /** La lectura de configuracion_sistema falla. */
  falla?: boolean;
  /** Otro guardado se cuela entre la lectura y la escritura (CAS / insert). */
  carrera?: boolean;
}) {
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const estado: { fila: FilaConfig | undefined } = { fila: m.fila };
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
          // Llave primaria `clave`: si otro la creó a la vez, 23505.
          if (m.carrera || estado.fila) {
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key' },
            };
          }
          const v = ins.args[0] as Fila;
          estado.fila = {
            valor_json: v.valor_json,
            updated_at: v.updated_at as string,
            updated_by: (v.updated_by as string | null) ?? null,
          };
          return { data: null, error: null };
        }
        const upd = ops.find((o) => o.m === 'update');
        if (upd) {
          // CAS REAL: solo escribe si el sello sigue siendo el que se leyó.
          const sello = eq('updated_at');
          if (
            m.carrera ||
            !estado.fila ||
            (sello !== undefined && sello !== estado.fila.updated_at)
          ) {
            return { data: [], error: null };
          }
          const v = upd.args[0] as Fila;
          estado.fila = {
            valor_json: v.valor_json,
            updated_at: v.updated_at as string,
            updated_by: (v.updated_by as string | null) ?? null,
          };
          return { data: [{ clave: CONFIG_ACCESO_NOMINA }], error: null };
        }
        if (eq('clave') === CONFIG_ACCESO_NOMINA) {
          return {
            data: estado.fila
              ? { clave: CONFIG_ACCESO_NOMINA, ...estado.fila }
              : null,
            error: null,
          };
        }
        return { data: unica ? null : [], error: null };
      }
      if (tabla === 'usuario') {
        let filas = USUARIOS;
        for (const i of ops.filter((o) => o.m === 'in')) {
          const col = i.args[0] as string;
          const vals = i.args[1] as unknown[];
          filas = filas.filter((u) => vals.includes(u[col]));
        }
        for (const e of ops.filter((o) => o.m === 'eq')) {
          filas = filas.filter((u) => u[e.args[0] as string] === e.args[1]);
        }
        return { data: filas, error: null };
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
  const lecturasConfig = () =>
    llamadas.filter((l) => l.tabla === 'configuracion_sistema').length;
  const escribio = () =>
    llamadas.some((l) =>
      l.ops.some((o) => o.m === 'update' || o.m === 'insert'),
    );
  return { svc, llamadas, estado, lecturasConfig, escribio };
}

const fila = (ids: unknown[], por: string | null = ALE): FilaConfig => ({
  valor_json: ids,
  updated_at: SELLO,
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

describe('ConfiguracionService — acceso a Nómina por persona', () => {
  it('la clave es la del contrato y tiene sección propia (fuera del listado y del PATCH genérico)', async () => {
    expect(CONFIG_ACCESO_NOMINA).toBe('acceso_nomina');
    const { svc, llamadas, escribio } = armar({ fila: fila([MARY]) });
    await svc.list();
    const ops = llamadas.find((l) => l.tabla === 'configuracion_sistema')!.ops;
    expect(ops).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_ACCESO_NOMINA],
    });
    // Las otras listas siguen excluidas.
    expect(ops).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_EDITORES_COTIZACION_COBRADA],
    });
    const { status, body } = await errorDe(
      svc.update(CONFIG_ACCESO_NOMINA, { activa: false }, ALE),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('CLAVE_NO_EDITABLE_AQUI');
    expect(String(body.message)).toContain('Acceso a Nómina');
    expect(escribio()).toBe(false);
  });

  it('en la lista: Mary sí; Villalobos (también Administración) no', async () => {
    const { svc } = armar({ fila: fila([MARY]) });
    expect(await svc.tieneAccesoNomina(MARY)).toBe(true);
    expect(await svc.tieneAccesoNomina(VILLALOBOS)).toBe(false);
    expect(await svc.tieneAccesoNomina(null)).toBe(false);
    expect(await svc.tieneAccesoNomina(undefined)).toBe(false);
  });

  it('sin la fila (nunca se ha guardado) nadie de Administración entra: igual que el 0.0.136', async () => {
    const { svc } = armar({});
    expect(await svc.tieneAccesoNomina(MARY)).toBe(false);
    expect(await svc.entraANomina(MARY, 'ADMIN')).toBe(false);
    const r = await svc.accesoNomina(direccion());
    expect(r.usuario_ids).toEqual([]);
    expect(r.usuarios).toEqual([]);
    expect(r.version).toBeNull();
    expect(r.actualizado_at).toBeNull();
    expect(r.actualizado_por_nombre).toBeNull();
  });

  it('lista ilegible ⇒ falla CERRADO (sin acceso) y /me no revienta', async () => {
    const { svc } = armar({ fila: fila([MARY]), falla: true });
    expect(await svc.tieneAccesoNomina(MARY)).toBe(false);
    expect(await svc.tieneAccesoNomina(MARY, { usarCache: false })).toBe(false);
    expect(await svc.entraANomina(MARY, 'ADMIN')).toBe(false);
    expect(await svc.permisosDe(MARY, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: false,
      gastos_personales: false,
    });
    // Quien entra por su rol no depende de la lista.
    expect(await svc.entraANomina(ALE, 'DIRECCION')).toBe(true);
  });

  it('valor editado a mano con basura: solo cuentan los uuids', async () => {
    const { svc } = armar({ fila: fila(['Mary', 42, MARY, MARY, null]) });
    expect((await svc.accesoNomina(direccion())).usuario_ids).toEqual([MARY]);
    expect(await svc.tieneAccesoNomina(MARY)).toBe(true);
  });

  it('entraANomina: Dirección, Coordinación y Facturación por su rol SIN leer la lista; Administración solo por la lista', async () => {
    const { svc, lecturasConfig } = armar({ fila: fila([MARY]) });
    for (const rol of ['DIRECCION', 'COORDINADOR', 'FACTURACION']) {
      expect(await svc.entraANomina(VILLALOBOS, rol)).toBe(true);
    }
    expect(lecturasConfig()).toBe(0);
    expect(await svc.entraANomina(MARY, 'ADMIN')).toBe(true);
    expect(await svc.entraANomina(VILLALOBOS, 'ADMIN')).toBe(false);
  });

  it('la lista solo le abre la puerta a Administración: un id guardado con otro rol NO entra (y ni se lee la lista)', async () => {
    const { svc, lecturasConfig } = armar({ fila: fila([MARY, PILOTO]) });
    for (const rol of [
      'PILOTO',
      'SOCIO',
      'ANALISTA',
      'MECANICO',
      'VISITANTE',
      null,
      undefined,
      '',
    ]) {
      expect(await svc.entraANomina(MARY, rol)).toBe(false);
    }
    expect(lecturasConfig()).toBe(0);
  });

  it('permisosDe (/me): `nomina` por rol o por la lista, junto al permiso de cotizaciones cobradas', async () => {
    const { svc } = armar({ fila: fila([MARY]) });
    // `gastos_personales` (invariante 133) es OTRA lista: el acceso a Nómina
    // no lo enciende.
    expect(await svc.permisosDe(MARY, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: true,
      gastos_personales: false,
    });
    expect(await svc.permisosDe(VILLALOBOS, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
      nomina: false,
      gastos_personales: false,
    });
    expect((await svc.permisosDe(ALE, 'DIRECCION')).nomina).toBe(true);
    expect((await svc.permisosDe(FACTU, 'FACTURACION')).nomina).toBe(true);
    expect((await svc.permisosDe(PILOTO, 'PILOTO')).nomina).toBe(false);
    expect((await svc.permisosDe(null, null)).nomina).toBe(false);
  });

  it('/me usa el caché de 60 s; los candados de Gastos (usarCache: false) leen SIEMPRE la lista vigente', async () => {
    const { svc, estado, lecturasConfig } = armar({ fila: fila([MARY]) });
    expect(await svc.tieneAccesoNomina(MARY)).toBe(true);
    expect(await svc.tieneAccesoNomina(MARY)).toBe(true);
    expect(lecturasConfig()).toBe(1);
    // Alguien la cambia por fuera de este proceso (otra réplica, SQL).
    estado.fila = fila([]);
    expect(await svc.tieneAccesoNomina(MARY)).toBe(true); // caché
    expect(await svc.tieneAccesoNomina(MARY, { usarCache: false })).toBe(false);
    // …y esa lectura fresca deja el caché al día.
    expect(await svc.tieneAccesoNomina(MARY)).toBe(false);
  });

  it('GET: lista, nombres, candidatos (Administración ACTIVA), quién entra por su rol, quién puede cambiarla y el último cambio', async () => {
    const { svc } = armar({ fila: fila([MARY, INACTIVO], PABLO) });
    const r = await svc.accesoNomina(direccion(DIEGO));
    expect(r.usuario_ids).toEqual([MARY, INACTIVO]);
    expect(r.usuarios).toEqual([
      { id: MARY, nombre: 'Mary Cruz' },
      { id: INACTIVO, nombre: 'Aero Charter Cancun S.A. de C.V.' },
    ]);
    // Solo Administración ACTIVA y de oficina: ni inactivos, ni externos, ni
    // Dirección/Coordinación/Facturación (ya entran por su rol), ni pilotos.
    expect(r.candidatos).toEqual([
      { id: VILLALOBOS, nombre: 'Alejandro Villalobos', rol: 'ADMIN' },
      { id: ITZI, nombre: 'Itzi', rol: 'ADMIN' },
      { id: MARY, nombre: 'Mary Cruz', rol: 'ADMIN' },
    ]);
    expect(r.por_rol.map((u) => [u.nombre, u.rol])).toEqual([
      ['Alejandro Canales', 'DIRECCION'],
      ['Coordinación', 'COORDINADOR'],
      ['Diego Ramírez', 'DIRECCION'],
      ['Facturación', 'FACTURACION'],
      ['Pablo Canales', 'DIRECCION'],
    ]);
    expect(r.puede_modificar).toBe(true);
    expect(r.version).toBe(SELLO);
    expect(r.actualizado_at).toBe(SELLO);
    expect(r.actualizado_por_nombre).toBe('Pablo Canales');
    // Administración la LEE pero no la cambia.
    expect((await svc.accesoNomina(admin())).puede_modificar).toBe(false);
  });

  it('PUT por Administración ⇒ 403 SOLO_DIRECCION_ACCESO_NOMINA (y no escribe), aunque esté en la lista', async () => {
    const { svc, escribio, estado } = armar({ fila: fila([MARY]) });
    for (const actor of [
      admin(VILLALOBOS),
      admin(MARY),
      { userId: FACTU, rol: 'FACTURACION' },
      { userId: COORD, rol: 'COORDINADOR' },
      { userId: PILOTO, rol: undefined },
    ]) {
      const { status, body } = await errorDe(
        svc.setAccesoNomina([MARY, VILLALOBOS], actor),
      );
      expect(status).toBe(403);
      expect(body.error).toBe('SOLO_DIRECCION_ACCESO_NOMINA');
      expect(body.message).toBe(
        'Solo Dirección puede cambiar quién entra a Nómina.',
      );
    }
    expect(escribio()).toBe(false);
    expect(estado.fila?.valor_json).toEqual([MARY]);
  });

  it('PUT con alguien que no es Administración ACTIVA ⇒ 400 USUARIOS_INVALIDOS con los ids (y no escribe)', async () => {
    const { svc, escribio } = armar({ fila: fila([MARY]) });
    const { status, body } = await errorDe(
      svc.setAccesoNomina(
        [MARY, ALE, FACTU, COORD, PILOTO, INACTIVO, EXTERNO],
        direccion(),
      ),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('USUARIOS_INVALIDOS');
    expect(body.details).toEqual({
      ids: [ALE, FACTU, COORD, PILOTO, INACTIVO, EXTERNO],
    });
    expect(String(body.message)).toContain('Administración');
    expect(escribio()).toBe(false);
  });

  it('primer PUT (sin fila): la CREA con su descripción, quién y cuándo; el acceso aplica al instante', async () => {
    const { svc, llamadas, estado } = armar({});
    // Calienta el caché de /me con «nadie».
    expect(await svc.permisosDe(MARY, 'ADMIN')).toMatchObject({
      nomina: false,
    });
    const r = await svc.setAccesoNomina([MARY, MARY], direccion(DIEGO), null);
    const ins = llamadas.flatMap((l) => l.ops).find((o) => o.m === 'insert')!
      .args[0] as Fila;
    expect(ins.clave).toBe(CONFIG_ACCESO_NOMINA);
    expect(ins.activa).toBe(true);
    expect(String(ins.descripcion)).toContain('Nómina');
    expect(ins.valor_json).toEqual([MARY]);
    expect(ins.updated_by).toBe(DIEGO);
    expect(estado.fila?.valor_json).toEqual([MARY]);
    expect(r.usuario_ids).toEqual([MARY]);
    expect(r.usuarios).toEqual([{ id: MARY, nombre: 'Mary Cruz' }]);
    expect(r.actualizado_por_nombre).toBe('Diego Ramírez');
    expect(r.version).toBe(estado.fila?.updated_at);
    // Sin esperar los 60 s del caché.
    expect(await svc.permisosDe(MARY, 'ADMIN')).toMatchObject({ nomina: true });
  });

  it('PUT con la fila: UPDATE con CAS sobre updated_at, sin repetidos; quitar el acceso aplica al instante', async () => {
    const { svc, llamadas, estado } = armar({ fila: fila([MARY]) });
    expect(await svc.tieneAccesoNomina(MARY)).toBe(true);
    const r = await svc.setAccesoNomina(
      [ITZI, VILLALOBOS, ITZI],
      direccion(PABLO),
      SELLO,
    );
    const upd = llamadas.find((l) => l.ops.some((o) => o.m === 'update'))!;
    expect(upd.ops).toContainEqual({ m: 'eq', args: ['updated_at', SELLO] });
    expect(upd.ops).toContainEqual({
      m: 'eq',
      args: ['clave', CONFIG_ACCESO_NOMINA],
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
    expect(estado.fila?.valor_json).toEqual([ITZI, VILLALOBOS]);
    expect(r.usuario_ids).toEqual([ITZI, VILLALOBOS]);
    expect(r.actualizado_por_nombre).toBe('Pablo Canales');
    // A Mary se le quitó: ni /me ni los candados la dejan pasar ya.
    expect(await svc.tieneAccesoNomina(MARY)).toBe(false);
    expect(await svc.entraANomina(MARY, 'ADMIN', { usarCache: false })).toBe(
      false,
    );
    expect(await svc.tieneAccesoNomina(ITZI)).toBe(true);
  });

  it('PUT con la lista VACÍA es válido: nadie de Administración entra', async () => {
    const { svc, estado } = armar({ fila: fila([MARY, ITZI]) });
    const r = await svc.setAccesoNomina([], direccion(), SELLO);
    expect(estado.fila?.valor_json).toEqual([]);
    expect(r.usuario_ids).toEqual([]);
    expect(await svc.tieneAccesoNomina(MARY)).toBe(false);
  });

  it('guardar desde una pantalla VIEJA (otro de Dirección ya cambió la lista) ⇒ 409 ACCESO_NOMINA_CAMBIO sin escribir: no le devuelve el acceso a quien se lo acaban de quitar', async () => {
    // Pablo acaba de quitar a Mary; la pantalla de Ale todavía la traía.
    const { svc, escribio, estado } = armar({ fila: fila([], PABLO) });
    const { status, body } = await errorDe(
      svc.setAccesoNomina(
        [MARY, ITZI],
        direccion(ALE),
        '2026-11-12T14:00:00.000+00:00',
      ),
    );
    expect(status).toBe(409);
    expect(body.error).toBe('ACCESO_NOMINA_CAMBIO');
    expect(String(body.message)).toContain('Recarga');
    expect(escribio()).toBe(false);
    expect(estado.fila?.valor_json).toEqual([]);
    // La pantalla creía que nunca se había guardado y ya existe la fila.
    expect(
      (await errorDe(svc.setAccesoNomina([MARY], direccion(ALE), null))).body
        .error,
    ).toBe('ACCESO_NOMINA_CAMBIO');
    // …y al revés: traía un sello pero la fila no existe.
    const sinFila = armar({});
    expect(
      (
        await errorDe(
          sinFila.svc.setAccesoNomina([MARY], direccion(ALE), SELLO),
        )
      ).body.error,
    ).toBe('ACCESO_NOMINA_CAMBIO');
    expect(sinFila.escribio()).toBe(false);
  });

  it('el sello se compara por INSTANTE («Z» = «+00:00»); sin `version` no hay comprobación de pantalla', async () => {
    const a = armar({ fila: fila([MARY]) });
    await a.svc.setAccesoNomina(
      [ITZI],
      direccion(),
      '2026-11-12T15:00:00.123Z',
    );
    expect(a.estado.fila?.valor_json).toEqual([ITZI]);
    const b = armar({ fila: fila([MARY]) });
    await b.svc.setAccesoNomina([ITZI], direccion());
    expect(b.estado.fila?.valor_json).toEqual([ITZI]);
  });

  it('dos guardados a la vez: el CAS (o el insert) pierde ⇒ 409 ACCESO_NOMINA_CAMBIO', async () => {
    const conFila = armar({ fila: fila([MARY]), carrera: true });
    const r1 = await errorDe(
      conFila.svc.setAccesoNomina([ITZI], direccion(), SELLO),
    );
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('ACCESO_NOMINA_CAMBIO');
    expect(conFila.estado.fila?.valor_json).toEqual([MARY]);
    const sinFila = armar({ carrera: true });
    const r2 = await errorDe(
      sinFila.svc.setAccesoNomina([ITZI], direccion(), null),
    );
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('ACCESO_NOMINA_CAMBIO');
    expect(sinFila.estado.fila).toBeUndefined();
  });
});
