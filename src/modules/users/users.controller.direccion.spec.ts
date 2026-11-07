/**
 * USUARIOS DE DIRECCIÓN (6-nov-2026, invariante 122). Pedido del dueño:
 * Administración (ADMIN) «no puede crear usuarios con rol de dirección o
 * editar usuarios a rol de dirección, los demás sí». Y, para que nadie suba
 * de privilegio por la puerta de atrás, Administración tampoco edita,
 * desactiva, cambia la contraseña ni reenvía la invitación de alguien que YA
 * es de Dirección. Dirección hace todo; COORDINADOR sigue acotado como antes.
 *
 * HTTP REAL (ValidationPipe, filtro y RolesGuard de producción) con el
 * `UsersService` REAL sobre una BD en memoria.
 */
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import {
  CODIGO_SOLO_DIRECCION_USUARIOS,
  MENSAJE_SOLO_DIRECCION_ASIGNA,
  MENSAJE_SOLO_DIRECCION_EDITA,
} from '../../common/roles.util';
import { Rol } from '../../common/types/auth.types';
import { SupabaseService } from '../supabase/supabase.service';
import { EmailService } from '../notifications/email.service';
import { PushService } from '../realtime/push.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

type Servidor = Parameters<typeof request>[0];
type Fila = Record<string, unknown>;
type Cuerpo = Record<string, unknown> & {
  code?: string;
  message?: string;
  rol?: string;
  estado?: string;
};

const ALE = 'c691cc8b-0000-4000-8000-000000000001';
const PABLO = 'e5aa04a8-0000-4000-8000-000000000002';
const ITZI = '5391362f-0000-4000-8000-000000000003';
const ZAMORA = 'a0a0a0a0-0000-4000-8000-000000000004';

function usuario(p: Fila): Fila {
  return {
    supabase_auth_id: 'auth',
    email: 'x@vuelatour.com',
    estado: 'ACTIVO',
    tiene_fondo_caja: false,
    tarjeta_terminacion: '',
    es_piloto: false,
    es_piloto_externo: false,
    es_empresa: false,
    telefono: '',
    avatar_url: '',
    apodo: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...p,
  };
}

/** PostgREST en memoria sobre `usuario`: select/eq/order/range/update/insert. */
function armarBd() {
  const tablas: Record<string, Fila[]> = {
    usuario: [
      usuario({
        id: ALE,
        nombre: 'Alejandro Canales',
        rol: 'DIRECCION',
        es_piloto: true,
      }),
      usuario({
        id: PABLO,
        nombre: 'Pablo Canales',
        rol: 'DIRECCION',
        es_piloto: true,
      }),
      usuario({ id: ITZI, nombre: 'Itzi', rol: 'ADMIN' }),
      usuario({
        id: ZAMORA,
        nombre: 'Abraham Zamora',
        rol: 'PILOTO',
        es_piloto: true,
      }),
    ],
    tarjeta_corporativa: [],
  };
  const escrituras: Array<{
    tabla: string;
    op: 'update' | 'insert';
    patch: Fila;
  }> = [];
  let siguiente = 1;

  const from = (tabla: string) => {
    const filtros: Array<(f: Fila) => boolean> = [];
    let patch: Fila | null = null;
    let alta: Fila | null = null;
    const q: Record<string, unknown> = {};
    const ejecutar = (): Fila[] => {
      if (alta) {
        const fila = usuario({ id: `nuevo-${siguiente++}`, ...alta });
        (tablas[tabla] ??= []).push(fila);
        escrituras.push({ tabla, op: 'insert', patch: { ...alta } });
        return [{ ...fila }];
      }
      const filas = (tablas[tabla] ?? []).filter((f) =>
        filtros.every((fn) => fn(f)),
      );
      if (patch) {
        const limpio = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        escrituras.push({ tabla, op: 'update', patch: limpio });
        for (const f of filas) Object.assign(f, limpio);
      }
      return filas.map((f) => ({ ...f }));
    };
    Object.assign(q, {
      select: () => q,
      order: () => q,
      limit: () => q,
      range: () => q,
      eq: (col: string, v: unknown) => {
        filtros.push((f) => f[col] === v);
        return q;
      },
      neq: (col: string, v: unknown) => {
        filtros.push((f) => f[col] !== v);
        return q;
      },
      update: (p: Fila) => {
        patch = p;
        return q;
      },
      insert: (p: Fila) => {
        alta = p;
        return q;
      },
      maybeSingle: () => {
        const filas = ejecutar();
        return Promise.resolve({ data: filas[0] ?? null, error: null });
      },
      then: (
        resolve: (v: { data: Fila[]; error: null; count: number }) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        const filas = ejecutar();
        return Promise.resolve({
          data: filas,
          error: null,
          count: filas.length,
        }).then(resolve, reject);
      },
    });
    return q;
  };
  return { tablas, escrituras, service: { from } };
}

describe('UsersController — Dirección y Administración por metadata', () => {
  it('las rutas siguen declarando ADMIN (DIRECCION pasa por el guard, no por las listas)', () => {
    const proto = UsersController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(ROLES_KEY, proto.list)).toEqual([Rol.ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.create)).toEqual([Rol.ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.softDelete)).toEqual([
      Rol.ADMIN,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.resetPassword)).toEqual([
      Rol.ADMIN,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.update)).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
  });
});

describe('UsersController — Dirección y Administración por HTTP', () => {
  let app: INestApplication;
  let actor: { userId: string; rol: Rol } = { userId: ITZI, rol: Rol.ADMIN };
  let bd = armarBd();
  const http = (): Servidor => app.getHttpServer() as Servidor;
  const sendUserInvitation = jest.fn();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        UsersService,
        {
          provide: SupabaseService,
          useValue: {
            get service() {
              return bd.service;
            },
          },
        },
        { provide: EmailService, useValue: { sendUserInvitation } },
        {
          provide: PushService,
          useValue: {
            contarDispositivosPorUsuario: jest
              .fn()
              .mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: unknown }).user = {
        ...actor,
        nombre: 'Actor',
      };
      next();
    });
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    actor = { userId: ITZI, rol: Rol.ADMIN };
    bd = armarBd();
    sendUserInvitation.mockReset();
  });

  const comoDireccion = () => {
    actor = { userId: ALE, rol: Rol.DIRECCION };
  };
  const patch = async (id: string, body: unknown) => {
    const r = await request(http())
      .patch(`/v1/users/${id}`)
      .send(body as object);
    return { status: r.status, body: r.body as Cuerpo };
  };
  const post = async (ruta: string, body: unknown) => {
    const r = await request(http())
      .post(ruta)
      .send(body as object);
    return { status: r.status, body: r.body as Cuerpo };
  };
  const esperar403 = (r: { status: number; body: Cuerpo }, mensaje: string) => {
    expect(r.status).toBe(403);
    expect(r.body.code).toBe(CODIGO_SOLO_DIRECCION_USUARIOS);
    expect(r.body.message).toBe(mensaje);
  };

  it('Administración NO crea un usuario de Dirección (403 antes de escribir); los demás roles sí', async () => {
    const r = await post('/v1/users', {
      nombre: 'Nuevo Director',
      email: 'nuevo@vuelatour.com',
      rol: 'DIRECCION',
    });
    esperar403(r, MENSAJE_SOLO_DIRECCION_ASIGNA);
    expect(bd.escrituras).toEqual([]);
    expect(sendUserInvitation).not.toHaveBeenCalled();

    const ok = await post('/v1/users', {
      nombre: 'Nueva Coordinadora',
      email: 'coord@vuelatour.com',
      rol: 'COORDINADOR',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.rol).toBe('COORDINADOR');
  });

  it('Dirección sí crea otro usuario de Dirección', async () => {
    comoDireccion();
    const r = await post('/v1/users', {
      nombre: 'Nuevo Director',
      email: 'nuevo@vuelatour.com',
      rol: 'DIRECCION',
      estado: 'ACTIVO',
    });
    expect(r.status).toBe(201);
    expect(r.body.rol).toBe('DIRECCION');
    expect(bd.escrituras.map((e) => e.op)).toEqual(['insert']);
  });

  it('Administración NO sube a nadie a Dirección (ni a sí misma) y NO edita a quien ya lo es', async () => {
    esperar403(
      await patch(ZAMORA, { rol: 'DIRECCION' }),
      MENSAJE_SOLO_DIRECCION_ASIGNA,
    );
    esperar403(
      await patch(ITZI, { rol: 'DIRECCION' }),
      MENSAJE_SOLO_DIRECCION_ASIGNA,
    );
    esperar403(
      await patch(ALE, { telefono: '+52 9981112233' }),
      MENSAJE_SOLO_DIRECCION_EDITA,
    );
    esperar403(
      await patch(PABLO, { estado: 'INACTIVO' }),
      MENSAJE_SOLO_DIRECCION_EDITA,
    );
    expect(bd.escrituras).toEqual([]);
  });

  it('Administración sigue editando a los demás (rol, estado, datos)', async () => {
    const r = await patch(ZAMORA, {
      telefono: '+52 9981112233',
      rol: 'COORDINADOR',
    });
    expect(r.status).toBe(200);
    expect(r.body.rol).toBe('COORDINADOR');
    expect(bd.escrituras).toHaveLength(1);
  });

  it('Dirección edita a Dirección y baja a alguien de Dirección a Administración', async () => {
    comoDireccion();
    const r = await patch(PABLO, { telefono: '+52 9981112233' });
    expect(r.status).toBe(200);
    const baja = await patch(PABLO, { rol: 'ADMIN' });
    expect(baja.status).toBe(200);
    expect(baja.body.rol).toBe('ADMIN');
  });

  it('desactivar, contraseña e invitación de alguien de Dirección: Administración 403, Dirección 200', async () => {
    const borrar = await request(http()).delete(`/v1/users/${ALE}`);
    expect(borrar.status).toBe(403);
    expect((borrar.body as Cuerpo).code).toBe(CODIGO_SOLO_DIRECCION_USUARIOS);
    esperar403(
      await post(`/v1/users/${ALE}/reset-password`, { password: 'secreto123' }),
      MENSAJE_SOLO_DIRECCION_EDITA,
    );
    esperar403(
      await post(`/v1/users/${ALE}/resend-invitation`, {}),
      MENSAJE_SOLO_DIRECCION_EDITA,
    );
    expect(bd.escrituras).toEqual([]);

    comoDireccion();
    const ok = await request(http()).delete(`/v1/users/${PABLO}`);
    expect(ok.status).toBe(200);
    expect((ok.body as Cuerpo).estado).toBe('INACTIVO');
  });

  it('Dirección pasa las rutas de ADMIN (lista y detalle de otro) aunque las listas no la nombren', async () => {
    comoDireccion();
    const lista = await request(http()).get('/v1/users');
    expect(lista.status).toBe(200);
    const uno = await request(http()).get(`/v1/users/${ZAMORA}`);
    expect(uno.status).toBe(200);
  });

  it('COORDINADOR sigue acotado como antes (403 SOLO_ADMIN_EDITA_USUARIOS sobre oficina)', async () => {
    actor = { userId: ITZI, rol: Rol.COORDINADOR };
    const r = await patch(ALE, { telefono: '+52 9981112233' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SOLO_ADMIN_EDITA_USUARIOS');
  });
});
