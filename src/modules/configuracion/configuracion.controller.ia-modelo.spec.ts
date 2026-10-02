// Cableado HTTP de «Modelo de IA» (2-oct-2026): rutas literales ANTES de
// ':clave', solo ADMIN, DTO por el ValidationPipe real de main.ts, el 400
// MODELO_INVALIDO del service a través del filtro global y el default del
// servidor pedido a pyservices. El service se stubbea (sus reglas se prueban
// en `configuracion.ia-modelo.spec.ts`).
jest.mock('./configuracion.service', () => ({
  ConfiguracionService: class {},
}));
jest.mock('../ia-uso/ia-uso.service', () => ({ IaUsoService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import {
  BadRequestException,
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
import { PyservicesService } from '../pyservices/pyservices.service';

type Servidor = Parameters<typeof request>[0];
const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';
const RUTA = '/v1/config/ia-modelo';

const proto = ConfiguracionController.prototype as unknown as Record<
  string,
  object
>;

describe('ConfiguracionController — modelo de IA', () => {
  it('rutas literales `ia-modelo` (GET y PUT) declaradas ANTES de `:clave`', () => {
    const metodos = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor',
    );
    const rutas = metodos.map((m) =>
      String(Reflect.getMetadata(PATH_METADATA, proto[m])),
    );
    const clave = rutas.indexOf(':clave');
    const literales = rutas
      .map((r, i) => (r === 'ia-modelo' ? i : -1))
      .filter((i) => i >= 0);
    expect(literales).toHaveLength(2);
    for (const i of literales) expect(i).toBeLessThan(clave);
  });

  describe('por HTTP', () => {
    let app: INestApplication;
    let rol: Rol = Rol.ADMIN;
    const respuesta = {
      configurado: null,
      default_servidor: 'claude-opus-4-8',
      efectivo: 'claude-opus-4-8',
      catalogo: [],
      actualizado_at: null,
      actualizado_por_nombre: null,
      aviso: null,
    };
    const svc = {
      modeloIaConfig: jest.fn().mockResolvedValue(respuesta),
      setModeloIa: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({}),
    };
    const py = {
      modeloIaServidor: jest.fn().mockResolvedValue('claude-opus-4-8'),
    };
    const http = (): Servidor => app.getHttpServer() as Servidor;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ConfiguracionController],
        providers: [
          { provide: ConfiguracionService, useValue: svc },
          { provide: IaUsoService, useValue: {} },
          { provide: PyservicesService, useValue: py },
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
          userId: ALE,
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
      jest.clearAllMocks();
    });

    it('GET llega a su ruta (no a `:clave`) con el default que reporta pyservices', async () => {
      const r = await request(http()).get(RUTA);
      expect(r.status).toBe(200);
      expect(r.body).toEqual(respuesta);
      expect(py.modeloIaServidor).toHaveBeenCalledTimes(1);
      expect(svc.modeloIaConfig).toHaveBeenCalledWith('claude-opus-4-8');
    });

    it('GET con pyservices viejo/caído: el default llega null y la ruta responde 200', async () => {
      py.modeloIaServidor.mockResolvedValueOnce(null);
      const r = await request(http()).get(RUTA);
      expect(r.status).toBe(200);
      expect(svc.modeloIaConfig).toHaveBeenCalledWith(null);
    });

    it('solo ADMIN: COORDINADOR, FACTURACION, PILOTO, MECANICO, SOCIO, VISITANTE ⇒ 403 (GET y PUT)', async () => {
      for (const r of [
        Rol.COORDINADOR,
        Rol.FACTURACION,
        Rol.PILOTO,
        Rol.MECANICO,
        Rol.SOCIO,
        Rol.VISITANTE,
      ]) {
        rol = r;
        expect((await request(http()).get(RUTA)).status).toBe(403);
        expect(
          (await request(http()).put(RUTA).send({ modelo: 'claude-sonnet-5' }))
            .status,
        ).toBe(403);
      }
      expect(svc.setModeloIa).not.toHaveBeenCalled();
      expect(svc.modeloIaConfig).not.toHaveBeenCalled();
    });

    it('PUT con id: guarda con quién cambia y responde lo mismo que el GET', async () => {
      const r = await request(http())
        .put(RUTA)
        .send({ modelo: 'claude-sonnet-5' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual(respuesta);
      expect(svc.setModeloIa).toHaveBeenCalledWith('claude-sonnet-5', ALE);
      expect(svc.modeloIaConfig).toHaveBeenCalledWith('claude-opus-4-8');
      // Primero se guarda y DESPUÉS se lee lo que responde.
      expect(svc.setModeloIa.mock.invocationCallOrder[0]).toBeLessThan(
        svc.modeloIaConfig.mock.invocationCallOrder[0],
      );
    });

    it('PUT { modelo: null } = volver al del servidor', async () => {
      const r = await request(http()).put(RUTA).send({ modelo: null });
      expect(r.status).toBe(200);
      expect(svc.setModeloIa).toHaveBeenCalledWith(null, ALE);
    });

    it('el 400 MODELO_INVALIDO del service viaja con su código y no responde config', async () => {
      svc.setModeloIa.mockRejectedValueOnce(
        new BadRequestException({
          message: 'El id del modelo no es válido…',
          error: 'MODELO_INVALIDO',
          details: { modelo: 'gpt-4o' },
        }),
      );
      const r = await request(http()).put(RUTA).send({ modelo: 'gpt-4o' });
      expect(r.status).toBe(400);
      expect((r.body as { code?: string }).code).toBe('MODELO_INVALIDO');
      expect(svc.modeloIaConfig).not.toHaveBeenCalled();
    });

    it('DTO: sin `modelo`, número, arreglo, demasiado largo o campo extra ⇒ 400 sin llegar al service', async () => {
      for (const body of [
        {},
        { modelo: 5 },
        { modelo: ['claude-sonnet-5'] },
        { modelo: `claude-${'a'.repeat(300)}` },
        { modelo: 'claude-sonnet-5', extra: true },
      ]) {
        expect((await request(http()).put(RUTA).send(body)).status).toBe(400);
      }
      expect(svc.setModeloIa).not.toHaveBeenCalled();
    });

    it('PATCH /config/ia_modelo (la clave) cae en `:clave` y el service la rechaza con CLAVE_NO_EDITABLE_AQUI', async () => {
      svc.update.mockRejectedValueOnce(
        new BadRequestException({
          message:
            'Esta configuración se edita en Créditos de IA → Modelo de IA.',
          error: 'CLAVE_NO_EDITABLE_AQUI',
        }),
      );
      const r = await request(http())
        .patch('/v1/config/ia_modelo')
        .send({ activa: false });
      expect(r.status).toBe(400);
      expect((r.body as { code?: string }).code).toBe('CLAVE_NO_EDITABLE_AQUI');
      expect(svc.update).toHaveBeenCalledWith(
        'ia_modelo',
        { activa: false },
        ALE,
      );
    });
  });
});
