// Cableado HTTP REAL de los Excel de caja chica (24-sep-2026): versionado
// URI + ValidationPipe + AllExceptionsFilter + StreamableFile. El servicio
// se stubbea: su lógica vive en caja-chica.reposicion-xlsx.spec.ts.
import {
  ConflictException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { CajaChicaController } from './caja-chica.controller';
import { CajaChicaService } from './caja-chica.service';

const MOV = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const FONDO = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Servidor = Parameters<typeof request>[0];

describe('CajaChicaController — Excel de reposición por HTTP', () => {
  let app: INestApplication;
  const reposicionXlsx = jest.fn();
  const porReponerXlsx = jest.fn();
  const getFondoDetail = jest.fn();
  const http = (): Servidor => app.getHttpServer() as Servidor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CajaChicaController],
      providers: [
        {
          provide: CajaChicaService,
          useValue: { reposicionXlsx, porReponerXlsx, getFondoDetail },
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
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    reposicionXlsx.mockReset();
    porReponerXlsx.mockReset();
    getFondoDetail.mockReset();
    reposicionXlsx.mockResolvedValue({
      buffer: Buffer.from('PK-reposicion'),
      filename: 'Reposicion caja Alexander E. Saab 2026-09-21.xlsx',
    });
    porReponerXlsx.mockResolvedValue({
      buffer: Buffer.from('PK-pendiente'),
      filename: 'Por reponer caja Luis Caceres 2026-09-24.xlsx',
    });
    getFondoDetail.mockResolvedValue({ id: FONDO });
  });

  it('GET movimientos/:id/reposicion.xlsx → el xlsx con su nombre', async () => {
    const res = await request(http())
      .get(`/v1/caja-chica/movimientos/${MOV}/reposicion.xlsx`)
      .buffer(true)
      .parse((r, cb) => {
        const partes: Buffer[] = [];
        r.on('data', (c: Buffer) => partes.push(c));
        r.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(XLSX);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="Reposicion caja Alexander E. Saab 2026-09-21.xlsx"; ' +
        "filename*=UTF-8''Reposicion%20caja%20Alexander%20E.%20Saab%202026-09-21.xlsx",
    );
    expect((res.body as Buffer).toString()).toBe('PK-reposicion');
    expect(reposicionXlsx).toHaveBeenCalledWith(MOV);
  });

  it('GET fondos/:id/por-reponer.xlsx NO lo captura `fondos/:id` (ruta propia)', async () => {
    const res = await request(http()).get(
      `/v1/caja-chica/fondos/${FONDO}/por-reponer.xlsx`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(XLSX);
    expect(res.headers['content-disposition']).toContain(
      'filename="Por reponer caja Luis Caceres 2026-09-24.xlsx"',
    );
    expect(porReponerXlsx).toHaveBeenCalledWith(FONDO);
    expect(getFondoDetail).not.toHaveBeenCalled();
  });

  it('el 409 MOVIMIENTO_NO_ES_REPOSICION llega con su code y su mensaje', async () => {
    reposicionXlsx.mockRejectedValue(
      new ConflictException({
        message:
          'Solo las reposiciones tienen Excel de lo repuesto; este movimiento es «Ajuste».',
        error: 'MOVIMIENTO_NO_ES_REPOSICION',
      }),
    );
    const res = await request(http()).get(
      `/v1/caja-chica/movimientos/${MOV}/reposicion.xlsx`,
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'MOVIMIENTO_NO_ES_REPOSICION' });
  });

  it('id que no es uuid ⇒ 400 antes de tocar el servicio', async () => {
    const res = await request(http()).get(
      '/v1/caja-chica/movimientos/no-es-uuid/reposicion.xlsx',
    );
    expect(res.status).toBe(400);
    expect(reposicionXlsx).not.toHaveBeenCalled();
  });

  it('solo GESTIÓN (ADMIN/FACTURACION) descarga: mismo candado que registrar la reposición', () => {
    const roles = (m: keyof CajaChicaController) =>
      Reflect.getMetadata(ROLES_KEY, CajaChicaController.prototype[m]) as Rol[];
    expect(roles('reposicionXlsx')).toEqual([Rol.ADMIN, Rol.FACTURACION]);
    expect(roles('porReponerXlsx')).toEqual([Rol.ADMIN, Rol.FACTURACION]);
    expect(roles('createMovimiento')).toEqual([Rol.ADMIN, Rol.FACTURACION]);
  });
});
