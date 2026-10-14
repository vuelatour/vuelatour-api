// Cableado HTTP del ALIAS del cliente (ID de vuelo por cliente, 13-oct-2026,
// invariante 68): orden de rutas, roles y los DTO por el ValidationPipe real
// de main.ts. El servicio se stubbea (no se toca la BD).
jest.mock('./clients.service', () => ({ ClientsService: class {} }));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { MENSAJE_ALIAS_INVALIDO } from '../../common/clave-cliente.util';
import { CreateClienteDto, UpdateClienteDto } from './dto/clients.dto';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

type Servidor = Parameters<typeof request>[0];
const ID = 'cccccccc-0000-4000-8000-000000000001';

const proto = ClientsController.prototype as unknown as Record<string, object>;

describe('ClientsController — GET alias-en-uso por metadata', () => {
  it('solo ADMIN y COORDINADOR (quien da de alta o edita clientes)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, proto.aliasEnUso)).toEqual([
      Rol.ADMIN,
      Rol.COORDINADOR,
    ]);
  });

  it('declarada ANTES de `:id` (si no, ParseUUIDPipe la captura)', () => {
    const metodos = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor',
    );
    const rutas = metodos.map((m) =>
      String(Reflect.getMetadata(PATH_METADATA, proto[m])),
    );
    expect(rutas).toContain('alias-en-uso');
    expect(rutas.indexOf('alias-en-uso')).toBeLessThan(rutas.indexOf(':id'));
  });
});

describe('CreateClienteDto / UpdateClienteDto — alias', () => {
  const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;
  const crear = (plain: Record<string, unknown>) =>
    plainToInstance(CreateClienteDto, plain, {
      enableImplicitConversion: true,
    });

  it("' DIEGO ' ⇒ 'diego' (recorta y minúsculas) y es válido", async () => {
    const d = crear({ nombre: 'Diego Ramírez', alias: ' DIEGO ' });
    expect(d.alias).toBe('diego');
    expect(await validate(d, OPTS)).toEqual([]);
  });

  it("'' ⇒ null (= volver al sugerido) y es válido", async () => {
    const d = crear({ nombre: 'Diego Ramírez', alias: '' });
    expect(d.alias).toBeNull();
    expect(await validate(d, OPTS)).toEqual([]);
  });

  it("'diego2', 'ñandu' o 25 letras ⇒ error con el mensaje EXACTO", async () => {
    for (const alias of ['diego2', 'ñandu', 'abcdefghijklmnopqrstuvwxy']) {
      const errores = await validate(crear({ nombre: 'X', alias }), OPTS);
      expect(errores.map((e) => e.property)).toEqual(['alias']);
      expect(Object.values(errores[0].constraints ?? {})).toContain(
        MENSAJE_ALIAS_INVALIDO,
      );
    }
  });

  it('sin alias ⇒ válido y `undefined` (= no se toca; el servicio decide por valor)', async () => {
    const d = crear({ nombre: 'Diego Ramírez' });
    expect(await validate(d, OPTS)).toEqual([]);
    // Con target ES2022+ la clase define TODAS sus llaves (en undefined): el
    // servicio compara `dto.alias !== undefined`, nunca la presencia.
    expect(d.alias).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('alias');
  });

  it('UpdateClienteDto hereda la regla: null ⇒ válido; vacío ⇒ null; inválido ⇒ error', async () => {
    const upd = (plain: Record<string, unknown>) =>
      plainToInstance(UpdateClienteDto, plain, {
        enableImplicitConversion: true,
      });
    expect(await validate(upd({ alias: null }), OPTS)).toEqual([]);
    const vacio = upd({ alias: '  ' });
    expect(vacio.alias).toBeNull();
    expect(await validate(vacio, OPTS)).toEqual([]);
    const mal = await validate(upd({ alias: 'Juan Pablo' }), OPTS);
    expect(mal.map((e) => e.property)).toEqual(['alias']);
  });
});

describe('ClientsController — por HTTP (ValidationPipe de main.ts)', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const svc = {
    aliasEnUso: jest.fn((alias: string) =>
      Promise.resolve({ alias, clientes: [] }),
    ),
    findById: jest.fn().mockResolvedValue({ id: ID }),
    create: jest.fn((dto: unknown) => Promise.resolve(dto)),
    update: jest.fn((_id: string, dto: unknown) => Promise.resolve(dto)),
  };
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ClientsController],
      providers: [{ provide: ClientsService, useValue: svc }],
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
        userId: 'u-1',
        nombre: 'Mary',
        rol,
      };
      next();
    });
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rol = Rol.ADMIN;
    jest.clearAllMocks();
  });

  it('?alias=Juan ⇒ 200 y el servicio recibe «juan» (no cae en `:id`)', async () => {
    const r = await request(http()).get('/v1/clients/alias-en-uso?alias=Juan');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ alias: 'juan', clientes: [] });
    expect(svc.aliasEnUso).toHaveBeenCalledWith('juan', undefined);
    expect(svc.findById).not.toHaveBeenCalled();
  });

  it('con excluir (uuid) ⇒ llega al servicio', async () => {
    const r = await request(http()).get(
      `/v1/clients/alias-en-uso?alias=juan&excluir=${ID}`,
    );
    expect(r.status).toBe(200);
    expect(svc.aliasEnUso).toHaveBeenCalledWith('juan', ID);
  });

  it('alias inválido o vacío, excluir que no es uuid o sin alias ⇒ 400 (sin llamar al servicio)', async () => {
    const r = await request(http()).get('/v1/clients/alias-en-uso?alias=juan2');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain(MENSAJE_ALIAS_INVALIDO);
    for (const qs of ['?alias=', '?alias=juan&excluir=x', '']) {
      expect(
        (await request(http()).get(`/v1/clients/alias-en-uso${qs}`)).status,
      ).toBe(400);
    }
    expect(svc.aliasEnUso).not.toHaveBeenCalled();
    expect(svc.findById).not.toHaveBeenCalled();
  });

  it('FACTURACION / SOCIO / PILOTO ⇒ 403', async () => {
    for (const r of [Rol.FACTURACION, Rol.SOCIO, Rol.PILOTO]) {
      rol = r;
      expect(
        (await request(http()).get('/v1/clients/alias-en-uso?alias=juan'))
          .status,
      ).toBe(403);
    }
  });

  it('POST con alias « DIEGO » ⇒ el servicio recibe «diego»; PATCH con alias null ⇒ null', async () => {
    const alta = await request(http())
      .post('/v1/clients')
      .send({ nombre: 'Diego Ramírez', alias: ' DIEGO ' });
    expect(alta.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ nombre: 'Diego Ramírez', alias: 'diego' }),
      'u-1',
    );
    const edicion = await request(http())
      .patch(`/v1/clients/${ID}`)
      .send({ alias: null });
    expect(edicion.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ alias: null }),
      'u-1',
    );
    const mal = await request(http())
      .patch(`/v1/clients/${ID}`)
      .send({ alias: 'Juan Pablo' });
    expect(mal.status).toBe(400);
  });
});
