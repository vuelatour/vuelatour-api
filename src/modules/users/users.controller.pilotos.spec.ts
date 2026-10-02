/**
 * `PATCH /v1/users/:id` abierto a COORDINADOR para editar los datos de un
 * PILOTO (2-oct-2026, contrato «Pilotos: editar datos + tarjetas»).
 *
 * HTTP REAL (ValidationPipe, filtro y RolesGuard de producción) con el
 * `UsersService` REAL sobre una BD en memoria: lo que se congela es la
 * cadena completa — rol de la ruta, acotación del servicio y `code` del 403
 * a través del filtro.
 *
 *  - Pablo Canales (ADMIN que también vuela) desde COORDINADOR ⇒ 403
 *    `SOLO_ADMIN_EDITA_USUARIOS` sin escribir nada;
 *  - un piloto ⇒ 200 (nombre, teléfono, apodo y tarjeta libre o propia);
 *  - un campo de ADMIN (rol, estado, fondo, banderas) ⇒ 403;
 *  - la tarjeta de OTRA persona ⇒ 403 `TARJETA_DE_OTRO_USUARIO` con su nombre;
 *  - ADMIN sin cambio; FACTURACION sigue fuera (RolesGuard).
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
import { Rol } from '../../common/types/auth.types';
import { SupabaseService } from '../supabase/supabase.service';
import { EmailService } from '../notifications/email.service';
import { PushService } from '../realtime/push.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import {
  MENSAJE_USUARIO_DE_OFICINA,
  mensajeTarjetaDeOtroUsuario,
} from './usuario-edicion.util';

type Servidor = Parameters<typeof request>[0];
type Fila = Record<string, unknown>;
/** Cuerpo de la respuesta (fila de usuario o error del filtro). */
type Cuerpo = Record<string, unknown> & {
  code?: string;
  message?: string;
  telefono?: string;
  tarjeta_terminacion?: string;
};

const PABLO = 'e5aa04a8-0000-4000-8000-000000000001';
const ZAMORA = 'a0a0a0a0-0000-4000-8000-000000000002';
const EXTERNO = 'b0b0b0b0-0000-4000-8000-000000000003';
const CACERES = 'c0c0c0c0-0000-4000-8000-000000000004';
const ITZEL = 'd0d0d0d0-0000-4000-8000-000000000005';

function usuario(p: Fila): Fila {
  return {
    supabase_auth_id: 'auth',
    email: 'x@vuelatour.com',
    estado: 'ACTIVO',
    tiene_fondo_caja: false,
    tarjeta_terminacion: '',
    es_piloto: false,
    es_piloto_externo: false,
    telefono: '',
    avatar_url: '',
    apodo: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...p,
  };
}

/**
 * PostgREST en memoria: `select/eq/neq/order/limit/update/maybeSingle/then`
 * sobre `usuario` y `tarjeta_corporativa`. Registra cada escritura.
 */
function armarBd() {
  const tablas: Record<string, Fila[]> = {
    usuario: [
      usuario({
        id: PABLO,
        nombre: 'Pablo Canales',
        rol: 'ADMIN',
        es_piloto: true,
        apodo: 'Pab',
      }),
      usuario({
        id: ZAMORA,
        nombre: 'Abraham Zamora',
        rol: 'PILOTO',
        es_piloto: true,
        tarjeta_terminacion: '0593',
      }),
      usuario({
        id: EXTERNO,
        nombre: 'Carlos Muciño',
        rol: 'PILOTO',
        es_piloto: true,
        es_piloto_externo: true,
        supabase_auth_id: null,
      }),
      usuario({
        id: CACERES,
        nombre: 'Luis Cáceres',
        rol: 'MECANICO',
        tarjeta_terminacion: '0585',
      }),
    ],
    tarjeta_corporativa: [
      { id: 't-0593', terminacion: '0593', usuario_id: ZAMORA, activa: true },
      { id: 't-0585', terminacion: '0585', usuario_id: CACERES, activa: true },
      { id: 't-1111', terminacion: '1111', usuario_id: null, activa: true },
    ],
  };
  const escrituras: Array<{ tabla: string; patch: Fila; filtros: string[] }> =
    [];

  const from = (tabla: string) => {
    const filtros: Array<(f: Fila) => boolean> = [];
    const etiquetas: string[] = [];
    let patch: Fila | null = null;
    const q: Record<string, unknown> = {};
    const ejecutar = () => {
      const filas = (tablas[tabla] ?? []).filter((f) =>
        filtros.every((fn) => fn(f)),
      );
      if (patch) {
        const limpio = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        escrituras.push({ tabla, patch: limpio, filtros: [...etiquetas] });
        for (const f of filas) Object.assign(f, limpio);
      }
      return filas.map((f) => ({ ...f }));
    };
    Object.assign(q, {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (col: string, v: unknown) => {
        filtros.push((f) => f[col] === v);
        etiquetas.push(`${col}=${String(v)}`);
        return q;
      },
      neq: (col: string, v: unknown) => {
        filtros.push((f) => f[col] !== v);
        etiquetas.push(`${col}!=${String(v)}`);
        return q;
      },
      update: (p: Fila) => {
        patch = p;
        return q;
      },
      maybeSingle: () => {
        const filas = ejecutar();
        return Promise.resolve({ data: filas[0] ?? null, error: null });
      },
      then: (
        resolve: (v: { data: Fila[]; error: null }) => unknown,
        reject?: (e: unknown) => unknown,
      ) =>
        Promise.resolve({ data: ejecutar(), error: null }).then(
          resolve,
          reject,
        ),
    });
    return q;
  };
  return { tablas, escrituras, service: { from } };
}

describe('UsersController — PATCH por metadata', () => {
  it('ADMIN y COORDINADOR (los demás siguen fuera)', () => {
    const proto = UsersController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(ROLES_KEY, proto.update)).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
    // El resto del controller NO se abrió.
    expect(Reflect.getMetadata(ROLES_KEY, proto.list)).toEqual([Rol.ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.softDelete)).toEqual([
      Rol.ADMIN,
    ]);
  });
});

describe('UsersController — PATCH /v1/users/:id para pilotos (HTTP real)', () => {
  let app: INestApplication;
  let rol: Rol = Rol.COORDINADOR;
  let bd = armarBd();
  const http = (): Servidor => app.getHttpServer() as Servidor;

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
        {
          provide: EmailService,
          useValue: { sendUserInvitation: jest.fn() },
        },
        {
          provide: PushService,
          useValue: { contarDispositivosPorUsuario: jest.fn() },
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
        userId: ITZEL,
        nombre: 'Itzel',
        rol,
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
    rol = Rol.COORDINADOR;
    bd = armarBd();
  });

  const patch = async (id: string, body: unknown) => {
    const r = await request(http())
      .patch(`/v1/users/${id}`)
      .send(body as object);
    return { status: r.status, body: r.body as Cuerpo };
  };

  it('Pablo Canales (ADMIN + es_piloto) desde COORDINADOR ⇒ 403 SOLO_ADMIN_EDITA_USUARIOS', async () => {
    const r = await patch(PABLO, { telefono: '+52 9981112233' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({
      code: 'SOLO_ADMIN_EDITA_USUARIOS',
      message: MENSAJE_USUARIO_DE_OFICINA,
    });
    expect(bd.escrituras).toEqual([]);
  });

  it('piloto ⇒ 200: nombre, teléfono y apodo', async () => {
    const r = await patch(ZAMORA, {
      nombre: 'Abraham Zamora P.',
      telefono: '+52 9981112233',
      apodo: ' Zamora ',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: ZAMORA,
      nombre: 'Abraham Zamora P.',
      telefono: '+52 9981112233',
      apodo: 'Zamora',
    });
    const usuarioUpd = bd.escrituras.filter((e) => e.tabla === 'usuario');
    expect(usuarioUpd).toHaveLength(1);
    expect(usuarioUpd[0].patch).toEqual({
      nombre: 'Abraham Zamora P.',
      telefono: '+52 9981112233',
      apodo: 'Zamora',
      updated_by: ITZEL,
    });
  });

  it('piloto externo ⇒ 200', async () => {
    const r = await patch(EXTERNO, { telefono: '+52 9980000000' });
    expect(r.status).toBe(200);
    expect(r.body.telefono).toBe('+52 9980000000');
  });

  it('campo de ADMIN (rol, estado, fondo, banderas) ⇒ 403 sin escribir', async () => {
    for (const extra of [
      { rol: 'ADMIN' },
      { estado: 'INACTIVO' },
      { tiene_fondo_caja: true },
      { es_piloto: false },
      { es_piloto_externo: true },
    ]) {
      const r = await patch(ZAMORA, { nombre: 'Abraham Zamora', ...extra });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('SOLO_ADMIN_EDITA_USUARIOS');
      expect(r.body.message).toMatch(/^Solo un ADMIN cambia /);
    }
    expect(bd.escrituras).toEqual([]);
  });

  it('tarjeta de OTRA persona ⇒ 403 TARJETA_DE_OTRO_USUARIO con su nombre', async () => {
    const r = await patch(ZAMORA, { tarjeta_terminacion: '0585' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({
      code: 'TARJETA_DE_OTRO_USUARIO',
      message: mensajeTarjetaDeOtroUsuario('Luis Cáceres'),
    });
    // Ni la tarjeta ni los usuarios se tocaron.
    expect(bd.escrituras).toEqual([]);
    expect(
      bd.tablas.tarjeta_corporativa.find((t) => t.id === 't-0585')?.usuario_id,
    ).toBe(CACERES);
  });

  it('tarjeta LIBRE ⇒ 200 y queda vinculada al piloto', async () => {
    const r = await patch(ZAMORA, { tarjeta_terminacion: '1111' });
    expect(r.status).toBe(200);
    expect(
      bd.tablas.tarjeta_corporativa.find((t) => t.id === 't-1111')?.usuario_id,
    ).toBe(ZAMORA);
    expect(r.body.tarjeta_terminacion).toBe('1111');
  });

  it('su PROPIA tarjeta ⇒ 200 sin re-vincular nada', async () => {
    const r = await patch(ZAMORA, { tarjeta_terminacion: '0593' });
    expect(r.status).toBe(200);
    expect(
      bd.escrituras.filter((e) => e.tabla === 'tarjeta_corporativa'),
    ).toEqual([]);
  });

  it('quitar la tarjeta (null) ⇒ 200 y el espejo queda vacío', async () => {
    const r = await patch(ZAMORA, { tarjeta_terminacion: null });
    expect(r.status).toBe(200);
    expect(r.body.tarjeta_terminacion).toBe('');
    expect(
      bd.tablas.tarjeta_corporativa.find((t) => t.id === 't-0593')?.usuario_id,
    ).toBeNull();
  });

  it('ADMIN sin cambio: edita a Pablo y reasigna una tarjeta ajena', async () => {
    rol = Rol.ADMIN;
    const r1 = await patch(PABLO, { telefono: '+52 9981112233', rol: 'ADMIN' });
    expect(r1.status).toBe(200);
    const r2 = await patch(ZAMORA, { tarjeta_terminacion: '0585' });
    expect(r2.status).toBe(200);
    expect(
      bd.tablas.tarjeta_corporativa.find((t) => t.id === 't-0585')?.usuario_id,
    ).toBe(ZAMORA);
  });

  it('FACTURACION sigue fuera (403 del RolesGuard, sin tocar la BD)', async () => {
    rol = Rol.FACTURACION;
    const r = await patch(ZAMORA, { telefono: '+52 9981112233' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect(bd.escrituras).toEqual([]);
  });

  it('id inexistente desde COORDINADOR ⇒ 404 (no se revela nada)', async () => {
    const r = await patch('f0f0f0f0-0000-4000-8000-00000000000f', {
      telefono: '+52 9981112233',
    });
    expect(r.status).toBe(404);
    expect(bd.escrituras).toEqual([]);
  });
});
