// Cableado HTTP REAL del CIERRE DE MES (16-oct-2026, API 0.0.88,
// invariante 89): ValidationPipe de main.ts + AllExceptionsFilter +
// versionado URI + RolesGuard. El servicio se stubbea.
jest.mock('./cierres.service', () => ({ CierresService: class {} }));

import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { CierresController } from './cierres.controller';
import { CierresService } from './cierres.service';

const USER = 'cccccccc-0000-4000-8000-0000000000a1';
const V = 'aaaaaaaa-0000-4000-8000-000000000337';
const V2 = 'aaaaaaaa-0000-4000-8000-000000000338';
const AV = 'bbbbbbbb-0000-4000-8000-000000000621';
type Servidor = Parameters<typeof request>[0];

describe('CierresController — @Roles en CADA ruta', () => {
  const proto = CierresController.prototype as unknown as Record<
    string,
    object
  >;
  it.each([
    [
      'estado',
      [Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION, Rol.COORDINADOR, Rol.SOCIO],
    ],
    ['previa', [Rol.ADMIN, Rol.FACTURACION, Rol.ANALISTA, Rol.COORDINADOR]],
    ['cerrar', [Rol.ADMIN, Rol.FACTURACION]],
    ['reabrir', [Rol.ADMIN]],
  ])('%s', (metodo, roles) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[metodo])).toEqual(roles);
  });
});

describe('CierresController por HTTP', () => {
  let app: INestApplication;
  let rol: Rol = Rol.ADMIN;
  const estado = jest.fn();
  const previa = jest.fn();
  const cerrar = jest.fn();
  const reabrir = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CierresController],
      providers: [
        {
          provide: CierresService,
          useValue: { estado, previa, cerrar, reabrir },
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
        userId: USER,
        rol,
        nombre: 'Ale',
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
    for (const f of [estado, previa, cerrar, reabrir]) f.mockReset();
    estado.mockResolvedValue({ disponible: true, meses: [] });
    previa.mockResolvedValue({ periodo: '2026-09' });
    cerrar.mockResolvedValue({ cierre: { periodo: '2026-09' } });
    reabrir.mockResolvedValue({ cierre: { periodo: '2026-09' } });
  });

  it('GET /v1/cierres: SOCIO lee; PILOTO ⇒ 403', async () => {
    rol = Rol.SOCIO;
    expect((await request(http()).get('/v1/cierres')).status).toBe(200);
    rol = Rol.PILOTO;
    expect((await request(http()).get('/v1/cierres')).status).toBe(403);
  });

  it('GET previa: periodo inválido ⇒ 400 PERIODO_INVALIDO sin llamar al servicio; SOCIO ⇒ 403', async () => {
    const r = await request(http()).get('/v1/cierres/2026-13/previa');
    expect(r.status).toBe(400);
    expect((r.body as { code?: string }).code).toBe('PERIODO_INVALIDO');
    expect(previa).not.toHaveBeenCalled();
    expect(
      (await request(http()).get('/v1/cierres/2026-09/previa')).status,
    ).toBe(200);
    expect(previa).toHaveBeenCalledWith('2026-09', {
      incluir: undefined,
      aeronaveId: undefined,
    });
    rol = Rol.SOCIO;
    expect(
      (await request(http()).get('/v1/cierres/2026-09/previa')).status,
    ).toBe(403);
  });

  it('GET previa ?aeronave_id (invariante 105): uuid ⇒ llega al servicio; inválido ⇒ 400 sin llamarlo; ?incluir se parte por comas', async () => {
    const r = await request(http()).get(
      `/v1/cierres/2026-09/previa?aeronave_id=${AV}&incluir=${V},${V2}`,
    );
    expect(r.status).toBe(200);
    expect(previa).toHaveBeenCalledWith('2026-09', {
      incluir: [V, V2],
      aeronaveId: AV,
    });
    previa.mockClear();
    expect(
      (
        await request(http()).get(
          '/v1/cierres/2026-09/previa?aeronave_id=no-uuid',
        )
      ).status,
    ).toBe(400);
    expect(previa).not.toHaveBeenCalled();
  });

  it('POST cerrar: ADMIN y FACTURACION (201); COORDINADOR ⇒ 403; `confirmar` ESTRICTO; llaves de más ⇒ 400', async () => {
    for (const r of [Rol.ADMIN, Rol.FACTURACION]) {
      rol = r;
      const res = await request(http())
        .post('/v1/cierres/2026-09')
        .send({ confirmar: true, vuelos_esperados: [V] });
      expect(res.status).toBe(201);
    }
    expect(cerrar).toHaveBeenLastCalledWith(
      '2026-09',
      { confirmar: true, vuelos_esperados: [V] },
      expect.objectContaining({ userId: USER, rol: Rol.FACTURACION }),
    );
    // CIERRE POR AVIÓN (invariante 105): `aeronave_id` uuid opcional.
    expect(
      (
        await request(http())
          .post('/v1/cierres/2026-09')
          .send({ confirmar: true, aeronave_id: AV })
      ).status,
    ).toBe(201);
    expect(cerrar).toHaveBeenLastCalledWith(
      '2026-09',
      { confirmar: true, aeronave_id: AV },
      expect.anything(),
    );
    rol = Rol.COORDINADOR;
    expect(
      (
        await request(http())
          .post('/v1/cierres/2026-09')
          .send({ confirmar: true })
      ).status,
    ).toBe(403);
    rol = Rol.ADMIN;
    for (const body of [
      {},
      { confirmar: 'true' },
      { confirmar: false },
      { confirmar: true, otra: 1 },
      { confirmar: true, vuelos_esperados: ['no-uuid'] },
      { confirmar: true, aeronave_id: 'no-uuid' },
    ]) {
      expect(
        (await request(http()).post('/v1/cierres/2026-09').send(body)).status,
      ).toBe(400);
    }
  });

  it('POST reabrir: solo ADMIN, motivo 5–300 y confirmar', async () => {
    const ok = await request(http())
      .post('/v1/cierres/2026-09/reabrir')
      .send({ motivo: 'Faltó un gasto', confirmar: true });
    expect(ok.status).toBe(200);
    expect(reabrir).toHaveBeenCalledWith(
      '2026-09',
      { motivo: 'Faltó un gasto', confirmar: true },
      expect.objectContaining({ userId: USER }),
    );
    // CIERRE POR AVIÓN (invariante 105): `aeronave_id` uuid opcional.
    expect(
      (
        await request(http())
          .post('/v1/cierres/2026-09/reabrir')
          .send({ motivo: 'Faltó un gasto', confirmar: true, aeronave_id: AV })
      ).status,
    ).toBe(200);
    expect(reabrir).toHaveBeenLastCalledWith(
      '2026-09',
      { motivo: 'Faltó un gasto', confirmar: true, aeronave_id: AV },
      expect.anything(),
    );
    expect(
      (
        await request(http())
          .post('/v1/cierres/2026-09/reabrir')
          .send({ motivo: 'Faltó un gasto', confirmar: true, aeronave_id: 'x' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(http())
          .post('/v1/cierres/2026-09/reabrir')
          .send({ motivo: 'ab', confirmar: true })
      ).status,
    ).toBe(400);
    rol = Rol.FACTURACION;
    expect(
      (
        await request(http())
          .post('/v1/cierres/2026-09/reabrir')
          .send({ motivo: 'Faltó un gasto', confirmar: true })
      ).status,
    ).toBe(403);
  });
});
