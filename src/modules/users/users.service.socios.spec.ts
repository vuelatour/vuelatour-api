// SOCIO SIN ACCESO (19-oct-2026, API 0.0.97, invariante 95): alta rápida
// desde la card de propietarios del avión. Rol SOCIO, INACTIVO, sin
// invitación; un nombre repetido ⇒ 409 con el usuario existente.
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { CODIGO_SOCIO_YA_EXISTE, UsersService } from './users.service';
import { UsersController } from './users.controller';
import type { EmailService } from '../notifications/email.service';
import type { PushService } from '../realtime/push.service';
import { supabaseGrabador } from '../../common/inicio-oficial.fixture-spec';

type Fila = Record<string, unknown>;

function armar(existentes: Fila[] = [], errorInsert: unknown = null) {
  const g = supabaseGrabador((tabla, ops) => {
    if (tabla !== 'usuario') return undefined;
    const insert = ops.find((o) => o.m === 'insert');
    if (insert) {
      if (errorInsert) return { data: null, error: errorInsert };
      return {
        data: [{ id: 'nuevo', ...(insert.args[0] as object) }],
        error: null,
      };
    }
    return { data: existentes, error: null };
  });
  const sendUserInvitation = jest.fn().mockResolvedValue(true);
  const email = { sendUserInvitation } as unknown as EmailService;
  const push = {
    contarDispositivosPorUsuario: jest.fn().mockResolvedValue(new Map()),
  } as unknown as PushService;
  const service = new UsersService(g.supabase, email, push);
  const insertado = () =>
    g
      .de('usuario')
      .find((c) => c.ops.some((o) => o.m === 'insert'))
      ?.ops.find((o) => o.m === 'insert')?.args[0] as Fila | undefined;
  return { service, sendUserInvitation, insertado, ...g };
}

async function rechazo(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { constructor: unknown; getResponse(): unknown };
  }
  throw new Error('no rechazó');
}

describe('UsersService.createSocio', () => {
  it('nace SOCIO + INACTIVO, sin invitación, sin correo ni tarjeta; el nombre se limpia', async () => {
    const { service, sendUserInvitation, insertado } = armar();
    const r = await service.createSocio({ nombre: '  Hernan   Garza ' }, 'u-1');
    expect(insertado()).toEqual({
      nombre: 'Hernan Garza',
      email: null,
      rol: Rol.SOCIO,
      estado: 'INACTIVO',
      es_empresa: false,
      tiene_fondo_caja: false,
      es_piloto: false,
      es_piloto_externo: false,
      telefono: null,
      created_by: 'u-1',
      updated_by: 'u-1',
    });
    expect(r.nombre).toBe('Hernan Garza');
    expect(sendUserInvitation).not.toHaveBeenCalled();
  });

  it('empresa con correo y teléfono', async () => {
    const { service, insertado } = armar();
    await service.createSocio(
      {
        nombre: 'Aero Charter Cancun S.A. de C.V.',
        es_empresa: true,
        email: ' Admin@AeroCharter.mx ',
        telefono: '998 123 4567',
      },
      'u-1',
    );
    expect(insertado()).toMatchObject({
      es_empresa: true,
      email: 'admin@aerocharter.mx',
      telefono: '998 123 4567',
    });
  });

  it('busca el nombre sin distinguir mayúsculas (ilike exacto, comodines escapados) y lee es_empresa', async () => {
    const { service, de } = armar();
    await service.createSocio({ nombre: 'Macedo_50%' }, 'u-1');
    const busca = de('usuario').find((c) =>
      c.ops.some((o) => o.m === 'ilike'),
    )!;
    expect(busca.ops.find((o) => o.m === 'ilike')!.args).toEqual([
      'nombre',
      'Macedo\\_50\\%',
    ]);
    expect(String(busca.ops.find((o) => o.m === 'select')!.args[0])).toContain(
      'es_empresa',
    );
  });

  it('un usuario con el mismo nombre ⇒ 409 SOCIO_YA_EXISTE con details.usuario y sin insertar', async () => {
    const existente = {
      id: 'u-h',
      nombre: 'Hernan Garza',
      rol: 'SOCIO',
      estado: 'INACTIVO',
      es_empresa: false,
    };
    const { service, insertado } = armar([existente]);
    const e = await rechazo(
      service.createSocio({ nombre: 'hernan garza' }, 'u-1'),
    );
    expect(e.constructor).toBe(ConflictException);
    expect(e.getResponse()).toEqual({
      message:
        'Ya existe un usuario con ese nombre: Hernan Garza (SOCIO). Elígelo en la lista en vez de duplicarlo.',
      error: CODIGO_SOCIO_YA_EXISTE,
      details: { usuario: existente },
    });
    expect(insertado()).toBeUndefined();
  });

  it('correo repetido (23505) ⇒ 409 EMAIL_YA_EXISTE; nombre vacío ⇒ 400', async () => {
    const { service } = armar([], { code: '23505', message: 'dup' });
    const e = await rechazo(
      service.createSocio({ nombre: 'Nuevo', email: 'x@y.mx' }, 'u-1'),
    );
    expect(e.constructor).toBe(ConflictException);
    expect(e.getResponse()).toMatchObject({ error: 'EMAIL_YA_EXISTE' });
    const { service: s2 } = armar();
    expect(
      (await rechazo(s2.createSocio({ nombre: ' ' }, 'u-1'))).constructor,
    ).toBe(BadRequestException);
  });
});

describe('UsersController.createSocio', () => {
  it('POST users/socios es solo ADMIN', () => {
    const proto = UsersController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(ROLES_KEY, proto.createSocio)).toEqual([
      Rol.ADMIN,
    ]);
  });
});
