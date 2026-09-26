import { HttpException } from '@nestjs/common';
import {
  CONFIG_EDITORES_COTIZACION_COBRADA,
  CONFIG_RESPONSABLES_FACTURACION,
  ConfiguracionService,
} from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * EDITORES DE COTIZACIONES COBRADAS (26-sep-2026, migración
 * 20260926000001). Permiso por PERSONA, no por rol: en prod TODA la oficina
 * es ADMIN y solo Alejandro y Pablo Canales lo tienen (Alejandro Villalobos
 * también es ADMIN y NO). Reglas de la lista: solo quien YA está puede
 * cambiarla (403), nunca vacía (400), solo oficina activa (400); CAS sobre
 * `updated_at`; fuera del listado general y del PATCH genérico.
 */
type Fila = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';
const PABLO = 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1';
const VILLALOBOS = 'ee3c5690-467c-481d-940f-f4c06010155f';
const MARY = 'e0b26729-1f02-4dc0-9c1a-e7192e638478';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000e';
const INACTIVO = '5efca0e1-3474-4857-aabf-0f99c9457903';
/** Oficina ACTIVA de FACTURACION: el PUT la acepta, pero NO revisa cotizaciones. */
const FACTU = 'bbbbbbbb-0000-4000-8000-00000000fac7';
const SELLO = '2026-09-26T15:00:00.123456+00:00';

const USUARIOS: Fila[] = [
  {
    id: ALE,
    nombre: 'Alejandro Canales',
    rol: 'ADMIN',
    estado: 'ACTIVO',
    es_piloto_externo: false,
  },
  {
    id: VILLALOBOS,
    nombre: 'Alejandro Villalobos',
    rol: 'ADMIN',
    estado: 'ACTIVO',
    es_piloto_externo: false,
  },
  {
    id: MARY,
    nombre: 'Mary Cruz',
    rol: 'ADMIN',
    estado: 'ACTIVO',
    es_piloto_externo: false,
  },
  {
    id: PABLO,
    nombre: 'Pablo Canales',
    rol: 'ADMIN',
    estado: 'ACTIVO',
    es_piloto_externo: false,
  },
  {
    id: PILOTO,
    nombre: 'Piloto',
    rol: 'PILOTO',
    estado: 'ACTIVO',
    es_piloto_externo: false,
  },
  {
    id: FACTU,
    nombre: 'Facturación',
    rol: 'FACTURACION',
    estado: 'ACTIVO',
    es_piloto_externo: false,
  },
  {
    id: INACTIVO,
    nombre: 'Aero Charter Cancun S.A. de C.V.',
    rol: 'ADMIN',
    estado: 'INACTIVO',
    es_piloto_externo: false,
  },
];

function armar(m: {
  /** `valor_json` de la fila; `undefined` = la fila NO existe (sin migración). */
  editores?: unknown[];
  /** La lectura de configuracion_sistema falla. */
  falla?: boolean;
  /** El UPDATE con CAS no encuentra la fila (otro la cambió). */
  casFalla?: boolean;
}) {
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const estado = { editores: m.editores };
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
    const resolver = () => {
      if (tabla === 'configuracion_sistema') {
        if (m.falla) return { data: null, error: { message: 'caída' } };
        const upd = ops.find((o) => o.m === 'update');
        if (upd) {
          if (m.casFalla) return { data: [], error: null };
          estado.editores = (upd.args[0] as Fila).valor_json as unknown[];
          return {
            data: [{ clave: CONFIG_EDITORES_COTIZACION_COBRADA }],
            error: null,
          };
        }
        const clave = ops.find((o) => o.m === 'eq' && o.args[0] === 'clave')
          ?.args[1];
        if (clave === CONFIG_EDITORES_COTIZACION_COBRADA) {
          return {
            data:
              estado.editores === undefined
                ? null
                : { clave, valor_json: estado.editores, updated_at: SELLO },
            error: null,
          };
        }
        return { data: [], error: null };
      }
      if (tabla === 'usuario') {
        const ins = ops.filter((o) => o.m === 'in');
        let filas = USUARIOS;
        for (const i of ins) {
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
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res);
    return q;
  };
  const svc = new ConfiguracionService({
    service: { from },
  } as unknown as SupabaseService);
  return { svc, llamadas, estado };
}

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

describe('ConfiguracionService — editores de cotizaciones cobradas', () => {
  it('la clave es la del contrato', () => {
    expect(CONFIG_EDITORES_COTIZACION_COBRADA).toBe(
      'editores_cotizacion_cobrada',
    );
  });

  it('list() EXCLUYE las dos listas (responsables y editores)', async () => {
    const { svc, llamadas } = armar({ editores: [ALE, PABLO] });
    await svc.list();
    const ops = llamadas.find((l) => l.tabla === 'configuracion_sistema')!.ops;
    expect(ops).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_RESPONSABLES_FACTURACION],
    });
    expect(ops).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_EDITORES_COTIZACION_COBRADA],
    });
  });

  it('PATCH genérico de la clave ⇒ 400 CLAVE_NO_EDITABLE_AQUI (y no escribe)', async () => {
    const { svc, llamadas } = armar({ editores: [ALE] });
    const { status, body } = await errorDe(
      svc.update(CONFIG_EDITORES_COTIZACION_COBRADA, { activa: false }, ALE),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('CLAVE_NO_EDITABLE_AQUI');
    expect(String(body.message)).toContain('Editan cotizaciones cobradas');
    expect(llamadas.some((l) => l.ops.some((o) => o.m === 'update'))).toBe(
      false,
    );
  });

  it('permiso por PERSONA: Ale y Pablo sí, Villalobos (ADMIN) no', async () => {
    const { svc } = armar({ editores: [ALE, PABLO] });
    expect(await svc.puedeEditarCotizacionCobrada(ALE)).toBe(true);
    expect(await svc.puedeEditarCotizacionCobrada(PABLO)).toBe(true);
    expect(await svc.puedeEditarCotizacionCobrada(VILLALOBOS)).toBe(false);
    expect(await svc.puedeEditarCotizacionCobrada(null)).toBe(false);
  });

  it('sin la fila (migración sin aplicar) nadie tiene el permiso', async () => {
    const { svc } = armar({});
    expect(await svc.puedeEditarCotizacionCobrada(ALE)).toBe(false);
    expect((await svc.editoresCotizacionCobrada(ALE)).usuario_ids).toEqual([]);
  });

  it('lista ilegible ⇒ falla CERRADO (false) y /me no revienta', async () => {
    const { svc } = armar({ editores: [ALE], falla: true });
    expect(await svc.puedeEditarCotizacionCobrada(ALE)).toBe(false);
    expect(await svc.permisosDe(ALE, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
    });
    expect(await svc.editoresCotizacionCobradaNombres()).toEqual([]);
  });

  it('valor editado a mano con basura: solo cuentan los uuids', async () => {
    const { svc } = armar({ editores: ['Ale', 42, ALE, ALE] });
    expect((await svc.editoresCotizacionCobrada(ALE)).usuario_ids).toEqual([
      ALE,
    ]);
  });

  it('permisosDe (/me): exige estar en la lista Y un rol que revise cotizaciones', async () => {
    const { svc } = armar({ editores: [ALE, MARY] });
    expect(await svc.permisosDe(ALE, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: true,
    });
    expect(await svc.permisosDe(VILLALOBOS, 'ADMIN')).toEqual({
      editar_cotizacion_cobrada: false,
    });
    // En la lista pero con un rol que no revisa (no podría de todos modos).
    expect(await svc.permisosDe(MARY, 'FACTURACION')).toEqual({
      editar_cotizacion_cobrada: false,
    });
    expect(await svc.permisosDe(ALE, 'COORDINADOR')).toEqual({
      editar_cotizacion_cobrada: true,
    });
  });

  it('nombres para el 409: en el orden de la lista y solo oficina ACTIVA', async () => {
    const { svc } = armar({ editores: [PABLO, INACTIVO, ALE] });
    expect(await svc.editoresCotizacionCobradaNombres()).toEqual([
      { id: PABLO, nombre: 'Pablo Canales' },
      { id: ALE, nombre: 'Alejandro Canales' },
    ]);
  });

  it('nombres para el 409: nunca a alguien de la lista que NO revisa cotizaciones (FACTURACION), igual que /me', async () => {
    // Revisión adversaria 26-sep-2026: el PUT acepta oficina (FACTURACION
    // incluida), pero su /me dice false y la ruta de revise no la deja
    // pasar: mandar a «pedírselo» a esa persona sería mentir.
    const { svc } = armar({ editores: [FACTU, ALE] });
    expect(await svc.editoresCotizacionCobradaNombres()).toEqual([
      { id: ALE, nombre: 'Alejandro Canales' },
    ]);
    expect(await svc.permisosDe(FACTU, 'FACTURACION')).toEqual({
      editar_cotizacion_cobrada: false,
    });
  });

  it('GET: ids, usuarios con nombre, puede_modificar por quien consulta y candidatos de oficina activa', async () => {
    const { svc } = armar({ editores: [ALE, PABLO] });
    const r = await svc.editoresCotizacionCobrada(ALE);
    expect(r.usuario_ids).toEqual([ALE, PABLO]);
    expect(r.usuarios).toEqual([
      { id: ALE, nombre: 'Alejandro Canales' },
      { id: PABLO, nombre: 'Pablo Canales' },
    ]);
    expect(r.puede_modificar).toBe(true);
    expect(r.candidatos.map((c) => c.id).sort()).toEqual(
      [ALE, FACTU, MARY, PABLO, VILLALOBOS].sort(),
    );
    expect(
      (await svc.editoresCotizacionCobrada(VILLALOBOS)).puede_modificar,
    ).toBe(false);
  });

  it('PUT por alguien que NO está en la lista ⇒ 403 SOLO_EDITORES_COTIZACION_COBRADA (y no escribe)', async () => {
    const { svc, llamadas } = armar({ editores: [ALE, PABLO] });
    const { status, body } = await errorDe(
      svc.setEditoresCotizacionCobrada([ALE, PABLO, VILLALOBOS], VILLALOBOS),
    );
    expect(status).toBe(403);
    expect(body.error).toBe('SOLO_EDITORES_COTIZACION_COBRADA');
    expect(String(body.message)).toContain('Alejandro Canales, Pablo Canales');
    expect(llamadas.some((l) => l.ops.some((o) => o.m === 'update'))).toBe(
      false,
    );
  });

  it('PUT sin la fila sembrada ⇒ 403 (nadie puede, hasta la migración)', async () => {
    const { svc } = armar({});
    const { status, body } = await errorDe(
      svc.setEditoresCotizacionCobrada([ALE], ALE),
    );
    expect(status).toBe(403);
    expect(body.error).toBe('SOLO_EDITORES_COTIZACION_COBRADA');
  });

  it('PUT con la lista vacía ⇒ 400 LISTA_VACIA', async () => {
    const { svc, llamadas } = armar({ editores: [ALE, PABLO] });
    const { status, body } = await errorDe(
      svc.setEditoresCotizacionCobrada([], ALE),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('LISTA_VACIA');
    expect(llamadas.some((l) => l.ops.some((o) => o.m === 'update'))).toBe(
      false,
    );
  });

  it('PUT con un usuario que no es oficina ACTIVA ⇒ 400 USUARIOS_INVALIDOS con los ids', async () => {
    const { svc } = armar({ editores: [ALE, PABLO] });
    const { status, body } = await errorDe(
      svc.setEditoresCotizacionCobrada([ALE, PILOTO, INACTIVO], ALE),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('USUARIOS_INVALIDOS');
    expect(body.details).toEqual({ ids: [PILOTO, INACTIVO] });
  });

  it('PUT válido: guarda sin repetidos, con CAS sobre updated_at, y el permiso se refleja al instante', async () => {
    const { svc, llamadas, estado } = armar({ editores: [ALE, PABLO] });
    // Calienta el caché de /me con la lista vieja.
    expect(await svc.puedeEditarCotizacionCobrada(VILLALOBOS)).toBe(false);
    const r = await svc.setEditoresCotizacionCobrada(
      [ALE, VILLALOBOS, ALE],
      ALE,
    );
    expect(estado.editores).toEqual([ALE, VILLALOBOS]);
    const upd = llamadas.find((l) => l.ops.some((o) => o.m === 'update'))!;
    expect(upd.ops).toContainEqual({ m: 'eq', args: ['updated_at', SELLO] });
    expect(
      (upd.ops.find((o) => o.m === 'update')!.args[0] as Fila).updated_by,
    ).toBe(ALE);
    expect(r.usuario_ids).toEqual([ALE, VILLALOBOS]);
    expect(r.puede_modificar).toBe(true);
    // El caché se invalidó: el cambio aplica ya, sin esperar 60 s.
    expect(await svc.puedeEditarCotizacionCobrada(VILLALOBOS)).toBe(true);
  });

  it('PUT quitándose a sí mismo: permitido (queda Pablo) y puede_modificar pasa a false', async () => {
    const { svc } = armar({ editores: [ALE, PABLO] });
    const r = await svc.setEditoresCotizacionCobrada([PABLO], ALE);
    expect(r.usuario_ids).toEqual([PABLO]);
    expect(r.puede_modificar).toBe(false);
  });

  it('dos editores a la vez: el CAS pierde ⇒ 409 EDITORES_CAMBIARON', async () => {
    const { svc } = armar({ editores: [ALE, PABLO], casFalla: true });
    const { status, body } = await errorDe(
      svc.setEditoresCotizacionCobrada([ALE], ALE),
    );
    expect(status).toBe(409);
    expect(body.error).toBe('EDITORES_CAMBIARON');
  });
});
