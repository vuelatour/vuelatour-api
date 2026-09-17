import { Logger } from '@nestjs/common';
import { UsersService } from './users.service';
import type { EmailService } from '../notifications/email.service';
import type { PushService } from '../realtime/push.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { Rol } from '../../common/types/auth.types';

/**
 * `usuario.apodo` (B2 del pedido del 15-sep-2026, migración
 * `20260917000001`): nombre CORTO con el que la oficina conoce al piloto
 * («Saab», «Zamora», «Pab»). Es lo que sale en el TÍTULO del evento de Google
 * Calendar que lee Luis, el mecánico — el primer nombre no le dice nada.
 *
 * Todo es ADITIVO y el API TOLERA que la migración no esté aplicada: si
 * Postgres responde 42703 se degrada una vez y sigue sin `apodo`, en vez de
 * tumbar el alta / la edición / el listado de usuarios.
 */

type Res = {
  data: unknown;
  error: null | { code?: string; message: string };
  count?: number;
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };

/** Doble de Supabase: cada consulta a una tabla consume el siguiente Res. */
function armarSupabase(tablas: Record<string, Res[]>) {
  const llamadas: Llamada[] = [];
  const cursor: Record<string, number> = {};
  const siguiente = (tabla: string): Res => {
    const lista = tablas[tabla] ?? [{ data: null, error: null }];
    const i = cursor[tabla] ?? 0;
    cursor[tabla] = i + 1;
    return lista[Math.min(i, lista.length - 1)];
  };
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
        return q;
      };
    for (const m of [
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
    ]) {
      q[m] = registra(m);
    }
    q.maybeSingle = () => Promise.resolve(siguiente(tabla));
    q.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(siguiente(tabla)).then(resolve, reject);
    return q;
  };
  return { llamadas, service: { from } };
}

const USUARIO = {
  id: 'u-1',
  supabase_auth_id: 'auth-1',
  nombre: 'Alexander E. Saab',
  email: 'saab@vuelatour.com',
  rol: 'PILOTO',
  estado: 'ACTIVO',
  tiene_fondo_caja: false,
  tarjeta_terminacion: '',
  es_piloto: true,
  es_piloto_externo: false,
  telefono: '',
  avatar_url: '',
  apodo: 'Saab',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

const ERROR_42703 = {
  code: '42703',
  message: 'column usuario.apodo does not exist',
};

/**
 * Lo que responde PostgREST cuando la columna ausente va en el CUERPO del
 * insert/update: ni siquiera consulta a Postgres (schema cache) y el mensaje
 * NO contiene «does not exist».
 */
const ERROR_PGRST204 = {
  code: 'PGRST204',
  message: "Could not find the 'apodo' column of 'usuario' in the schema cache",
};

function armar(tablas: Record<string, Res[]>) {
  const sb = armarSupabase(tablas);
  const email = {
    sendUserInvitation: jest.fn().mockResolvedValue(true),
  } as unknown as EmailService;
  const push = {
    contarDispositivosPorUsuario: jest.fn().mockResolvedValue(new Map()),
  } as unknown as PushService;
  const service = new UsersService(
    { service: sb.service } as unknown as SupabaseService,
    email,
    push,
  );
  return { service, llamadas: sb.llamadas, email, push };
}

const de = (llamadas: Llamada[], metodo: string) =>
  llamadas.filter((l) => l.tabla === 'usuario' && l.metodo === metodo);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('UsersService — apodo (nombre corto del calendario)', () => {
  it('el SELECT pide apodo (listado y detalle)', async () => {
    const { service, llamadas } = armar({
      usuario: [{ data: [USUARIO], error: null, count: 1 }],
    });

    await service.list({ limit: 20, offset: 0 });

    expect(String(de(llamadas, 'select')[0].args[0])).toContain('apodo');
  });

  it('create guarda el apodo RECORTADO y lo devuelve', async () => {
    const { service, llamadas } = armar({
      usuario: [{ data: USUARIO, error: null }],
    });

    const creado = await service.create(
      {
        nombre: 'Alexander E. Saab',
        email: 'SAAB@vuelatour.com',
        rol: 'PILOTO' as Rol,
        apodo: '  Saab  ',
      },
      'admin-1',
    );

    expect(
      (de(llamadas, 'insert')[0].args[0] as Record<string, unknown>).apodo,
    ).toBe('Saab');
    expect(creado.apodo).toBe('Saab');
  });

  it('create sin apodo (o en blanco) guarda null: se usará el primer nombre', async () => {
    const { service, llamadas } = armar({
      usuario: [{ data: { ...USUARIO, apodo: null }, error: null }],
    });

    await service.create(
      {
        nombre: 'Luis Alberto Ramírez',
        email: 'luis@vuelatour.com',
        rol: 'PILOTO' as Rol,
        apodo: '   ',
      },
      'admin-1',
    );

    expect(
      (de(llamadas, 'insert')[0].args[0] as Record<string, unknown>).apodo,
    ).toBeNull();
  });

  it('update: "" QUITA el apodo (null), un valor lo recorta', async () => {
    const vacio = armar({ usuario: [{ data: USUARIO, error: null }] });
    await vacio.service.update('u-1', { apodo: '' }, 'admin-1');
    expect(
      (de(vacio.llamadas, 'update')[0].args[0] as Record<string, unknown>)
        .apodo,
    ).toBeNull();

    const puesto = armar({ usuario: [{ data: USUARIO, error: null }] });
    await puesto.service.update('u-1', { apodo: ' Zamora ' }, 'admin-1');
    expect(
      (de(puesto.llamadas, 'update')[0].args[0] as Record<string, unknown>)
        .apodo,
    ).toBe('Zamora');
  });

  it('MIGRACIÓN PENDIENTE (42703): se degrada una vez y NO tumba el alta', async () => {
    const { service, llamadas } = armar({
      // 1.º insert con apodo → 42703; 2.º sin apodo → ok.
      usuario: [
        { data: null, error: ERROR_42703 },
        { data: { ...USUARIO, apodo: undefined }, error: null },
      ],
    });

    const creado = await service.create(
      {
        nombre: 'Alexander E. Saab',
        email: 'saab@vuelatour.com',
        rol: 'PILOTO' as Rol,
        apodo: 'Saab',
      },
      'admin-1',
    );

    expect(creado.id).toBe('u-1');
    const inserts = de(llamadas, 'insert');
    expect(inserts).toHaveLength(2);
    // El reintento ya NO manda la columna que no existe…
    expect(inserts[1].args[0] as Record<string, unknown>).not.toHaveProperty(
      'apodo',
    );
    // …ni la pide en el select.
    expect(String(de(llamadas, 'select')[1].args[0])).not.toContain('apodo');
  });

  it('degradado una sola vez: la siguiente lectura ya no reintenta', async () => {
    const { service, llamadas } = armar({
      usuario: [
        { data: null, error: ERROR_42703 },
        { data: { ...USUARIO, apodo: undefined }, error: null },
      ],
    });

    await service.findById('u-1');
    const tras1 = de(llamadas, 'select').length;
    await service.findById('u-1');

    // La 1.ª lectura costó 2 selects (sondeo + degradado); la 2.ª, uno solo.
    expect(tras1).toBe(2);
    expect(de(llamadas, 'select')).toHaveLength(3);
    expect(String(de(llamadas, 'select')[2].args[0])).not.toContain('apodo');
  });

  /**
   * EL CASO REAL DEL HUECO (revisión adversaria 17-sep-2026): cuando la
   * columna que falta viaja en el CUERPO de un insert/update, PostgREST NO
   * llega a Postgres — la rechaza contra su schema cache con `PGRST204` y el
   * mensaje «Could not find the 'apodo' column of 'usuario' in the schema
   * cache», que NO dice «does not exist». El payload de `create` SIEMPRE
   * lleva `apodo`, así que con la regla vieja el alta de usuarios respondía
   * 500 durante toda la ventana entre el deploy y la migración.
   */
  it('MIGRACIÓN PENDIENTE (PGRST204 del schema cache): el alta TAMPOCO se cae', async () => {
    const { service, llamadas } = armar({
      usuario: [
        { data: null, error: ERROR_PGRST204 },
        { data: { ...USUARIO, apodo: undefined }, error: null },
      ],
    });

    const creado = await service.create(
      {
        nombre: 'Abraham Zamora',
        email: 'zamora@vuelatour.com',
        rol: 'PILOTO' as Rol,
        apodo: 'Zamora',
      },
      'admin-1',
    );

    expect(creado.id).toBe('u-1');
    const inserts = de(llamadas, 'insert');
    expect(inserts).toHaveLength(2);
    expect(inserts[1].args[0] as Record<string, unknown>).not.toHaveProperty(
      'apodo',
    );
  });

  it('MIGRACIÓN PENDIENTE (PGRST204): la EDICIÓN tampoco se cae', async () => {
    const { service, llamadas } = armar({
      usuario: [
        { data: null, error: ERROR_PGRST204 },
        { data: { ...USUARIO, apodo: undefined }, error: null },
      ],
    });

    await service.update('u-1', { apodo: 'Pab' }, 'admin-1');

    const updates = de(llamadas, 'update');
    expect(updates).toHaveLength(2);
    expect(updates[1].args[0] as Record<string, unknown>).not.toHaveProperty(
      'apodo',
    );
  });

  it('un error que NO es 42703 se propaga tal cual (no se oculta)', async () => {
    const { service, llamadas } = armar({
      usuario: [{ data: null, error: { code: '57014', message: 'timeout' } }],
    });

    await expect(service.findById('u-1')).rejects.toThrow(/timeout/);
    // No hubo reintento a ciegas.
    expect(de(llamadas, 'select')).toHaveLength(1);
  });
});
