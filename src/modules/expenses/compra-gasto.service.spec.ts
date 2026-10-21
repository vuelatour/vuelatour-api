// Mismos stubs que expenses.service.inventario.spec.ts: el servicio importa
// ExpensesService (y este arrastra el gateway, la IA y pyservices).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { HttpException } from '@nestjs/common';
import { Rol } from '../../common/types/auth.types';
import type { ComprasService } from '../compras/compras.service';
import { CompraGastoService } from './compra-gasto.service';
import { CODIGO_COMPRA_GASTO } from './compra-gasto.util';
import { MedioPago } from './dto/expenses.dto';
import type { RegistrarGastoCompraDto } from './dto/compra-gasto.dto';
import type { ExpensesService } from './expenses.service';

/**
 * `CompraGastoService.registrarGasto` (21-oct-2026, invariante 101): bajo el
 * candado de la compra, valida con la regla pura, crea el gasto por el alta
 * de SIEMPRE con la liga en el mismo INSERT (`opts.compra`), fija el T.C. de
 * la compra si no tenía y responde el detalle fresco + el gasto creado.
 */
const COMPRA_ID = '0f5e6659-2c39-40d0-89d5-3fbd8d98537d';

function armar(
  extra: {
    pagos?: Array<{
      id: string;
      monto: string;
      moneda: string;
      compra_rol: string;
    }>;
    lineas?: number;
    totalFactura?: number;
    tcFijado?: boolean;
    sinCompras?: boolean;
  } = {},
) {
  const orden: string[] = [];
  const compras = {
    bajoCandado: jest.fn(async (id: string, fn: () => Promise<unknown>) => {
      orden.push(`candado:${id}`);
      return fn();
    }),
    calcularDe: jest.fn(async () => {
      orden.push('calcularDe');
      return {
        compra: {
          id: COMPRA_ID,
          folio: 12,
          referencia: 'AS-1234567',
          moneda: 'USD',
          proveedor_id: 'prov-as',
          proveedor: { id: 'prov-as', nombre: 'Aircraft Spruce' },
          estado: 'ABIERTA',
          tc_usd_mxn: null,
        },
        lineas: Array.from({ length: extra.lineas ?? 2 }, (_, i) => ({
          id: `l-${i}`,
        })),
        pagos: extra.pagos ?? [],
        resumen: { total_factura: extra.totalFactura ?? 722.9, moneda: 'USD' },
      };
    }),
    fijarTcSiFalta: jest.fn(async () => {
      orden.push('fijarTc');
      return extra.tcFijado ?? true;
    }),
    getDetail: jest.fn(async () => {
      orden.push('getDetail');
      return {
        id: COMPRA_ID,
        folio: 12,
        estado: 'ABIERTA',
        resumen: { gasto_estado: 'REGISTRADO' },
      };
    }),
  };
  const expenses = {
    create: jest.fn(async () => {
      orden.push('create');
      return {
        id: 'g-nuevo',
        monto: '722.90',
        moneda: 'USD',
        tc_gasto: '18.250000',
        fecha_gasto: '2026-10-21',
        medio_pago: 'TRANSFERENCIA',
        compra_id: COMPRA_ID,
        compra_rol: 'MERCANCIA',
      };
    }),
  };
  const service = new CompraGastoService(
    expenses as unknown as ExpensesService,
    extra.sinCompras ? undefined : (compras as unknown as ComprasService),
  );
  return { service, compras, expenses, orden };
}

const dto = (
  extra: Partial<RegistrarGastoCompraDto> = {},
): RegistrarGastoCompraDto => ({
  tc_usd_mxn: 18.25,
  fecha_gasto: '2026-10-21',
  medio_pago: MedioPago.TRANSFERENCIA,
  ...extra,
});

async function falla(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as {
        error?: string;
        message?: string;
        details?: unknown;
      };
      return {
        status: e.getStatus(),
        code: r.error,
        message: r.message,
        details: r.details,
      };
    }
    throw e;
  }
  throw new Error('no falló');
}

describe('registrarGasto: el camino feliz', () => {
  it('crea UN gasto REFACCION por el total de la factura con la liga en el INSERT, fija el T.C. de la compra y responde el detalle + el gasto', async () => {
    const { service, expenses, compras, orden } = armar();
    const r = (await service.registrarGasto(
      COMPRA_ID,
      dto({
        cuenta_bancaria_id: 'c0000000-0000-4000-8000-000000000001',
        notas: 'pagado hoy',
      }),
      'u-1',
      Rol.ADMIN,
    )) as Record<string, unknown>;
    expect(expenses.create).toHaveBeenCalledTimes(1);
    const [cuerpo, userId, rol, opts] = expenses.create.mock
      .calls[0] as unknown[];
    expect(cuerpo).toEqual({
      categoria: 'REFACCION',
      monto: 722.9,
      moneda: 'USD',
      tc_gasto: 18.25,
      fecha_gasto: '2026-10-21',
      medio_pago: 'TRANSFERENCIA',
      cuenta_bancaria_id: 'c0000000-0000-4000-8000-000000000001',
      proveedor_id: 'prov-as',
      notas: 'Compra #12 · Ref. AS-1234567 · Aircraft Spruce\npagado hoy',
    });
    expect(userId).toBe('u-1');
    expect(rol).toBe(Rol.ADMIN);
    expect(opts).toEqual({ compra: { id: COMPRA_ID, rol: 'MERCANCIA' } });
    expect(compras.fijarTcSiFalta).toHaveBeenCalledWith(
      COMPRA_ID,
      18.25,
      'u-1',
    );
    expect(r).toMatchObject({
      id: COMPRA_ID,
      folio: 12,
      gasto_registrado: {
        id: 'g-nuevo',
        monto: 722.9,
        moneda: 'USD',
        tc_gasto: 18.25,
      },
      tc_compra_fijado: true,
    });
    // Todo bajo el candado de la compra, en este orden.
    expect(orden).toEqual([
      `candado:${COMPRA_ID}`,
      'calcularDe',
      'create',
      'fijarTc',
      'getDetail',
    ]);
  });

  it('con medio EFECTIVO la cuenta no viaja aunque la manden (invariante 98)', async () => {
    const { service, expenses } = armar();
    await service.registrarGasto(
      COMPRA_ID,
      dto({
        medio_pago: MedioPago.EFECTIVO,
        cuenta_bancaria_id: 'c0000000-0000-4000-8000-000000000001',
      }),
      'u-1',
    );
    const [cuerpo] = expenses.create.mock.calls[0] as unknown[];
    expect(cuerpo).not.toHaveProperty('cuenta_bancaria_id');
  });
});

describe('registrarGasto: rechazos ANTES de crear nada', () => {
  it('409 COMPRA_GASTO_YA_REGISTRADO si la compra ya tiene su gasto de mercancía (idempotente)', async () => {
    const { service, expenses, compras } = armar({
      pagos: [
        {
          id: 'g-merc',
          monto: '722.90',
          moneda: 'USD',
          compra_rol: 'MERCANCIA',
        },
      ],
    });
    expect(
      await falla(service.registrarGasto(COMPRA_ID, dto(), 'u-1')),
    ).toMatchObject({
      status: 409,
      code: CODIGO_COMPRA_GASTO.YA_REGISTRADO,
      details: { gasto_id: 'g-merc' },
    });
    expect(expenses.create).not.toHaveBeenCalled();
    expect(compras.fijarTcSiFalta).not.toHaveBeenCalled();
  });

  it('400 TC_FUERA_DE_RANGO con un T.C. de 182.5 (dedo de más)', async () => {
    const { service, expenses } = armar();
    expect(
      await falla(
        service.registrarGasto(COMPRA_ID, dto({ tc_usd_mxn: 182.5 }), 'u-1'),
      ),
    ).toMatchObject({
      status: 400,
      code: CODIGO_COMPRA_GASTO.TC_FUERA_DE_RANGO,
    });
    expect(expenses.create).not.toHaveBeenCalled();
  });

  it('400 TC_REQUERIDO sin T.C. (cinturón: el DTO ya lo exige)', async () => {
    const { service, expenses } = armar();
    expect(
      await falla(
        service.registrarGasto(
          COMPRA_ID,
          dto({ tc_usd_mxn: undefined as unknown as number }),
          'u-1',
        ),
      ),
    ).toMatchObject({ status: 400, code: CODIGO_COMPRA_GASTO.TC_REQUERIDO });
    expect(expenses.create).not.toHaveBeenCalled();
  });

  it('400 COMPRA_SIN_LINEAS sin líneas; 400 COMPRA_SIN_MONTO con la factura en $0', async () => {
    const sinLineas = armar({ lineas: 0 });
    expect(
      await falla(sinLineas.service.registrarGasto(COMPRA_ID, dto(), 'u-1')),
    ).toMatchObject({
      status: 400,
      code: CODIGO_COMPRA_GASTO.SIN_LINEAS,
    });
    const sinMonto = armar({ totalFactura: 0 });
    expect(
      await falla(sinMonto.service.registrarGasto(COMPRA_ID, dto(), 'u-1')),
    ).toMatchObject({
      status: 400,
      code: CODIGO_COMPRA_GASTO.SIN_MONTO,
    });
    expect(sinLineas.expenses.create).not.toHaveBeenCalled();
    expect(sinMonto.expenses.create).not.toHaveBeenCalled();
  });

  it('un fallo del alta de siempre (p. ej. folio duplicado 409) sube tal cual y no toca el T.C. de la compra', async () => {
    const { service, expenses, compras } = armar();
    expenses.create.mockRejectedValueOnce(
      new HttpException('Ya existe un gasto con el folio', 409),
    );
    expect(
      await falla(service.registrarGasto(COMPRA_ID, dto(), 'u-1')),
    ).toMatchObject({ status: 409 });
    expect(compras.fijarTcSiFalta).not.toHaveBeenCalled();
    expect(compras.getDetail).not.toHaveBeenCalled();
  });

  it('503 REGISTRAR_GASTO_NO_DISPONIBLE sin el módulo de compras', async () => {
    const { service, expenses } = armar({ sinCompras: true });
    expect(
      await falla(service.registrarGasto(COMPRA_ID, dto(), 'u-1')),
    ).toMatchObject({
      status: 503,
      code: CODIGO_COMPRA_GASTO.NO_DISPONIBLE,
    });
    expect(expenses.create).not.toHaveBeenCalled();
  });
});
