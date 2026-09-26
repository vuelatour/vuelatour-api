// Cableado HTTP de «Editan cotizaciones cobradas» (26-sep-2026): rutas
// literales ANTES de ':clave', roles, DTO por el ValidationPipe real de
// main.ts y los códigos del service a través del filtro global. El service
// se stubbea (los candados se prueban en su propio spec).
jest.mock('./configuracion.service', () => ({
  ConfiguracionService: class {},
}));
jest.mock('../ia-uso/ia-uso.service', () => ({ IaUsoService: class {} }));

import {
  BadRequestException,
  ForbiddenException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../common/types/auth.types';
import { ConfiguracionController } from './configuracion.controller';
import { ConfiguracionService } from './configuracion.service';
import { IaUsoService } from '../ia-uso/ia-uso.service';

type Servidor = Parameters<typeof request>[0];
const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';
const PABLO = 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1';
const RUTA = '/v1/config/editores-cotizacion-cobrada';

const proto = ConfiguracionController.prototype as unknown as Record<
  string,
  object
>;

describe('ConfiguracionController — editores de cotizaciones cobradas', () => {
  it('rutas literales declaradas ANTES de `:clave` (convención del repo)', () => {
    const metodos = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor',
    );
    const rutas = metodos.map((m) =>
      String(Reflect.getMetadata(PATH_METADATA, proto[m])),
    );
    const i = rutas.indexOf('editores-cotizacion-cobrada');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(rutas.indexOf(':clave'));
  });

  describe('por HTTP', () => {
    let app: INestApplication;
    let rol: Rol = Rol.ADMIN;
    let userId = ALE;
    const respuesta = {
      usuario_ids: [ALE, PABLO],
      usuarios: [
        { id: ALE, nombre: 'Alejandro Canales' },
        { id: PABLO, nombre: 'Pablo Canales' },
      ],
      puede_modificar: true,
      candidatos: [],
    };
    const svc = {
      editoresCotizacionCobrada: jest.fn().mockResolvedValue(respuesta),
      setEditoresCotizacionCobrada: jest.fn().mockResolvedValue(respuesta),
      update: jest.fn(),
    };
    const http = (): Servidor => app.getHttpServer() as Servidor;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ConfiguracionController],
        providers: [
          { provide: ConfiguracionService, useValue: svc },
          { provide: IaUsoService, useValue: {} },
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
          userId,
          nombre: 'Oficina',
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
      userId = ALE;
      jest.clearAllMocks();
    });

    it('GET llega al service con quien consulta (no a `:clave`)', async () => {
      const r = await request(http()).get(RUTA);
      expect(r.status).toBe(200);
      expect(r.body).toEqual(respuesta);
      expect(svc.editoresCotizacionCobrada).toHaveBeenCalledWith(ALE);
    });

    it('oficina (ADMIN, COORDINADOR, FACTURACION) lee; PILOTO/MECANICO/SOCIO ⇒ 403', async () => {
      for (const r of [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION]) {
        rol = r;
        expect((await request(http()).get(RUTA)).status).toBe(200);
      }
      for (const r of [Rol.PILOTO, Rol.MECANICO, Rol.SOCIO, Rol.VISITANTE]) {
        rol = r;
        expect((await request(http()).get(RUTA)).status).toBe(403);
      }
    });

    it('PUT manda ids y quién cambia; la lista VACÍA llega al service (su código es LISTA_VACIA, no un 400 genérico)', async () => {
      const ok = await request(http())
        .put(RUTA)
        .send({ usuario_ids: [ALE, PABLO] });
      expect(ok.status).toBe(200);
      expect(svc.setEditoresCotizacionCobrada).toHaveBeenCalledWith(
        [ALE, PABLO],
        ALE,
      );
      svc.setEditoresCotizacionCobrada.mockRejectedValueOnce(
        new BadRequestException({
          message: 'La lista no puede quedar vacía…',
          error: 'LISTA_VACIA',
        }),
      );
      const vacia = await request(http()).put(RUTA).send({ usuario_ids: [] });
      expect(vacia.status).toBe(400);
      expect((vacia.body as { code?: string }).code).toBe('LISTA_VACIA');
    });

    it('el 403 SOLO_EDITORES_COTIZACION_COBRADA del service viaja con su código', async () => {
      svc.setEditoresCotizacionCobrada.mockRejectedValueOnce(
        new ForbiddenException({
          message: 'Solo quien ya puede editar…',
          error: 'SOLO_EDITORES_COTIZACION_COBRADA',
        }),
      );
      const r = await request(http())
        .put(RUTA)
        .send({ usuario_ids: [ALE] });
      expect(r.status).toBe(403);
      expect((r.body as { code?: string }).code).toBe(
        'SOLO_EDITORES_COTIZACION_COBRADA',
      );
    });

    it('DTO: id que no es uuid, sin arreglo o campo extra ⇒ 400 sin llegar al service', async () => {
      for (const body of [
        { usuario_ids: ['Ale'] },
        { usuario_ids: ALE },
        { usuario_ids: [ALE], extra: true },
        {},
      ]) {
        expect((await request(http()).put(RUTA).send(body)).status).toBe(400);
      }
      expect(svc.setEditoresCotizacionCobrada).not.toHaveBeenCalled();
    });

    it('PILOTO no llega al PUT (403 por rol)', async () => {
      rol = Rol.PILOTO;
      const r = await request(http())
        .put(RUTA)
        .send({ usuario_ids: [ALE] });
      expect(r.status).toBe(403);
      expect(svc.setEditoresCotizacionCobrada).not.toHaveBeenCalled();
    });
  });
});
