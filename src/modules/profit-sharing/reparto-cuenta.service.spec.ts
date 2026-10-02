// Las utilidades salen de ProfitSharingService.utilidadesSociosPorMes (aquí
// un doble): el servicio real arrastra pyservices/tipo de cambio/conciliación.
jest.mock('./profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));

import { Rol } from '../../common/types/auth.types';
import {
  AERO,
  ALE,
  MARY,
  MAURICIO,
  N4142R,
  PILOTO,
  SAAB,
  avionN4142R,
  errorDe,
  mundo,
  pagoFila,
} from './reparto-cuenta.fixture-spec';

/**
 * CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026) contra la BD en memoria:
 * resumen (cuenta default vs configurada, totales, SOCIO solo la suya),
 * estado de cuenta (saldo anterior, 403/404, rango), configuración de la
 * cuenta y sin la migración ⇒ disponible:false / 503.
 */
const ADMIN = { userId: ALE, rol: Rol.ADMIN };

describe('RepartoCuentaService.resumen', () => {
  it('cuenta DEFAULT (sep-2026, saldo 0, configurada:false): lo generado en septiembre queda POR ENTREGAR', async () => {
    const { cuentas, utilidadesSociosPorMes } = mundo();
    const r = await cuentas.resumen(ADMIN);
    expect(r.disponible).toBe(true);
    expect(r.hasta_mes).toBe('2026-10');
    // UN compute por mes de la cuenta, hasta el mes EN CURSO.
    expect(utilidadesSociosPorMes).toHaveBeenCalledWith(
      ['2026-09', '2026-10'],
      '2026-10',
      // Lectura: con la memoria de 10 min (solo las escrituras van frescas).
      { fresco: false },
    );
    expect(
      r.socios.map((s) => [s.socio.nombre, s.por_entregar_usd, s.estado]),
    ).toEqual([
      ['Aero Charter Cancun S.A. de C.V.', 586.7, 'POR_ENTREGAR'],
      ['Alexander E. Saab', 40.46, 'POR_ENTREGAR'],
      ['Mauricio Roque', 1395.94, 'POR_ENTREGAR'],
    ]);
    const mauricio = r.socios[2];
    expect(mauricio).toMatchObject({
      socio: {
        id: MAURICIO,
        nombre: 'Mauricio Roque',
        rol: 'SOCIO',
        estado: 'ACTIVO',
      },
      cuenta: {
        cuenta_desde: '2026-09',
        saldo_inicial_usd: 0,
        configurada: false,
      },
      generado_usd: 1395.94,
      mes_en_curso_usd: 0,
      entregado_usd: 0,
      ultimo_pago: null,
      aviones: [
        {
          id: N4142R,
          matricula: 'N4142R',
          porcentaje: 69,
          vigente: true,
          activa: true,
        },
        expect.objectContaining({ matricula: 'N990GG', vigente: false }),
      ],
    });
    expect(r.totales).toEqual({
      generado_usd: 2023.1,
      entregado_usd: 0,
      por_entregar_usd: 2023.1,
      adelantado_usd: 0,
      socios_por_entregar: 3,
      socios_adelantados: 0,
    });
  });

  it('cuenta CONFIGURADA: arranque y saldo inicial cuentan; entregas descuentan; el mes en curso suma aparte', async () => {
    const { cuentas, utilidadesSociosPorMes } = mundo({
      cuentas: [
        {
          socio_id: MAURICIO,
          cuenta_desde: '2026-08-01',
          saldo_inicial_usd: '500.00',
          notas: 'Pendiente de julio',
          created_by: ALE,
          created_at: '2026-10-01T15:00:00Z',
          updated_by: ALE,
          updated_at: '2026-10-01T15:00:00Z',
        },
      ],
      pagos: [pagoFila({ monto: 1000, monto_usd: 1000 })],
      utilidades: {
        '2026-08': [avionN4142R('cero')],
        '2026-09': [avionN4142R()],
        '2026-10': [
          {
            ...avionN4142R(),
            reparto: [{ ...avionN4142R().reparto[0], monto_usd: 207 }],
          },
        ],
      },
    });
    const r = await cuentas.resumen(ADMIN);
    // El arranque más viejo manda: desde agosto.
    expect(utilidadesSociosPorMes).toHaveBeenCalledWith(
      ['2026-08', '2026-09', '2026-10'],
      '2026-10',
      { fresco: false },
    );
    const m = r.socios.find((s) => s.socio.id === MAURICIO)!;
    expect(m).toMatchObject({
      cuenta: {
        cuenta_desde: '2026-08',
        saldo_inicial_usd: 500,
        notas: 'Pendiente de julio',
        configurada: true,
      },
      generado_usd: 1602.94,
      mes_en_curso_usd: 207,
      entregado_usd: 1000,
      // 500 + 1,395.94 + 207 − 1,000
      por_entregar_usd: 1102.94,
      estado: 'POR_ENTREGAR',
      ultimo_pago: {
        fecha_pago: '2026-10-01',
        monto: 1000,
        moneda: 'USD',
        monto_usd: 1000,
        metodo: 'TRANSFERENCIA',
      },
    });
  });

  it('SOCIO: solo su renglón y SIN totales (la lectura ya va acotada a él)', async () => {
    const { cuentas } = mundo({
      pagos: [pagoFila({ socio_id: AERO, monto: 10, monto_usd: 10 })],
    });
    const r = await cuentas.resumen({ userId: MAURICIO, rol: Rol.SOCIO });
    expect(r.socios.map((s) => s.socio.id)).toEqual([MAURICIO]);
    expect(r.totales).toBeNull();
    expect(JSON.stringify(r)).not.toContain('Aero Charter');
  });

  it('el universo incluye a quien tiene cuenta o entregas aunque ya no esté en aeronave_socio', async () => {
    const { cuentas } = mundo({
      pagos: [
        pagoFila({
          socio_id: PILOTO,
          aeronave_id: null,
          monto: 5,
          monto_usd: 5,
        }),
      ],
    });
    const r = await cuentas.resumen(ADMIN);
    const p = r.socios.find((s) => s.socio.id === PILOTO)!;
    expect(p).toMatchObject({
      socio: { nombre: 'Piloto X' },
      aviones: [],
      generado_usd: 0,
      entregado_usd: 5,
      por_entregar_usd: -5,
      estado: 'ADELANTADO',
    });
  });

  it('sin la migración: disponible:false, sin calcular utilidades', async () => {
    const { cuentas, utilidadesSociosPorMes } = mundo({ sinMigracion: true });
    expect(await cuentas.resumen(ADMIN)).toEqual({
      disponible: false,
      hasta_mes: '2026-10',
      socios: [],
      totales: null,
    });
    expect(utilidadesSociosPorMes).not.toHaveBeenCalled();
  });

  it('si el cálculo de un mes falla, la lectura FALLA (nunca un número parcial)', async () => {
    const { cuentas, utilidadesSociosPorMes } = mundo();
    utilidadesSociosPorMes.mockRejectedValueOnce(new Error('timeout'));
    await expect(cuentas.resumen(ADMIN)).rejects.toThrow('timeout');
  });
});

describe('RepartoCuentaService.estadoDeCuenta', () => {
  it('default: desde el arranque hasta el mes en curso, con saldo corrido, comprobante firmado y nombres', async () => {
    const { cuentas } = mundo({
      pagos: [
        pagoFila({
          comprobante_path: `${MAURICIO}/p1/u.pdf`,
          monto: 1000,
          monto_usd: 1000,
        }),
      ],
    });
    const r = await cuentas.estadoDeCuenta(MAURICIO, {}, ADMIN);
    if (!r.disponible) throw new Error('debía estar disponible');
    expect([r.desde, r.hasta, r.saldo_anterior_usd]).toEqual([
      '2026-09',
      '2026-10',
      0,
    ]);
    expect(r.movimientos.map((m) => [m.tipo, m.concepto, m.saldo_usd])).toEqual(
      [
        ['SALDO_INICIAL', 'Arranque de la cuenta (saldo inicial $0)', 0],
        ['UTILIDAD', 'Utilidad sep 2026 · N4142R 69 %', 1395.94],
        [
          'ENTREGA',
          'Entrega · Transferencia · ref SPEI 001 · corresponde a sep 2026 · N4142R',
          395.94,
        ],
      ],
    );
    expect(r.movimientos[2].pago).toMatchObject({
      entregado_por_nombre: 'Mary Cruz',
      created_by_nombre: 'Ale Canales',
      aeronave: { id: N4142R, matricula: 'N4142R' },
      comprobante_url: `https://firmada/reparto-comprobantes/${MAURICIO}/p1/u.pdf?exp=28800`,
    });
    expect(r.totales).toMatchObject({
      por_entregar_usd: 395.94,
      estado: 'POR_ENTREGAR',
    });
    expect(
      r.por_mes.map((m) => [
        m.mes,
        m.utilidad_usd,
        m.en_curso,
        m.entregado_usd,
      ]),
    ).toEqual([
      ['2026-09', 1395.94, false, 0],
      ['2026-10', 0, true, 1000],
    ]);
  });

  it('desde = octubre: SALDO_ANTERIOR con lo de septiembre', async () => {
    const { cuentas } = mundo({
      pagos: [
        pagoFila({ fecha_pago: '2026-09-20', monto: 200, monto_usd: 200 }),
      ],
    });
    const r = await cuentas.estadoDeCuenta(
      MAURICIO,
      { desde: '2026-10' },
      ADMIN,
    );
    if (!r.disponible) throw new Error('debía estar disponible');
    expect(r.saldo_anterior_usd).toBe(1195.94);
    expect(r.movimientos).toEqual([
      expect.objectContaining({
        tipo: 'SALDO_ANTERIOR',
        concepto: 'Saldo al cierre de sep 2026',
        saldo_usd: 1195.94,
      }),
    ]);
  });

  it('hasta futuro se recorta al mes en curso; rango invertido ⇒ 400', async () => {
    const { cuentas } = mundo();
    const r = await cuentas.estadoDeCuenta(
      MAURICIO,
      { hasta: '2027-03' },
      ADMIN,
    );
    expect(r.disponible && r.hasta).toBe('2026-10');
    expect(
      await errorDe(
        cuentas.estadoDeCuenta(
          MAURICIO,
          { desde: '2026-10', hasta: '2026-09' },
          ADMIN,
        ),
      ),
    ).toMatchObject({ status: 400, code: 'RANGO_INVALIDO' });
  });

  it('SOCIO: la suya sí; la de otro ⇒ 403 SOCIO_SOLO_SU_CUENTA (sin leer nada)', async () => {
    const { cuentas, utilidadesSociosPorMes } = mundo();
    const propia = await cuentas.estadoDeCuenta(
      MAURICIO,
      {},
      { userId: MAURICIO, rol: Rol.SOCIO },
    );
    expect(propia.disponible).toBe(true);
    utilidadesSociosPorMes.mockClear();
    expect(
      await errorDe(
        cuentas.estadoDeCuenta(AERO, {}, { userId: MAURICIO, rol: Rol.SOCIO }),
      ),
    ).toMatchObject({ status: 403, code: 'SOCIO_SOLO_SU_CUENTA' });
    expect(utilidadesSociosPorMes).not.toHaveBeenCalled();
  });

  it('socio desconocido ⇒ 404 SOCIO_NO_EXISTE; sin la migración ⇒ disponible:false', async () => {
    const { cuentas } = mundo();
    expect(
      await errorDe(cuentas.estadoDeCuenta(MARY, {}, ADMIN)),
    ).toMatchObject({
      status: 404,
      code: 'SOCIO_NO_EXISTE',
    });
    const sin = mundo({ sinMigracion: true });
    expect(await sin.cuentas.estadoDeCuenta(MAURICIO, {}, ADMIN)).toEqual({
      disponible: false,
    });
  });
});

describe('RepartoCuentaService.configurarCuenta', () => {
  it('sin fila ⇒ INSERT (created_by); con fila ⇒ UPDATE que CONSERVA created_by; responde el renglón recalculado', async () => {
    const { cuentas, tablas } = mundo();
    const r1 = await cuentas.configurarCuenta(
      MAURICIO,
      {
        cuenta_desde: '2026-08',
        saldo_inicial_usd: -1500.25,
        notas: '  Ya adelantado  ',
      },
      ADMIN,
    );
    expect(tablas.reparto_cuenta_socio).toEqual([
      expect.objectContaining({
        socio_id: MAURICIO,
        cuenta_desde: '2026-08-01',
        saldo_inicial_usd: -1500.25,
        notas: 'Ya adelantado',
        created_by: ALE,
        updated_by: ALE,
      }),
    ]);
    // −1,500.25 + 0 (agosto) + 1,395.94 (septiembre) = −104.31
    expect(r1).toMatchObject({
      cuenta: {
        cuenta_desde: '2026-08',
        saldo_inicial_usd: -1500.25,
        configurada: true,
      },
      por_entregar_usd: -104.31,
      estado: 'ADELANTADO',
    });
    const r2 = await cuentas.configurarCuenta(
      MAURICIO,
      { cuenta_desde: '2026-09', saldo_inicial_usd: 0 },
      { userId: MARY, rol: Rol.FACTURACION },
    );
    expect(tablas.reparto_cuenta_socio).toHaveLength(1);
    expect(tablas.reparto_cuenta_socio[0]).toMatchObject({
      cuenta_desde: '2026-09-01',
      saldo_inicial_usd: 0,
      notas: null,
      created_by: ALE,
      updated_by: MARY,
    });
    expect(r2).toMatchObject({
      por_entregar_usd: 1395.94,
      estado: 'POR_ENTREGAR',
    });
  });

  it('reglas: socio fuera de aeronave_socio, arranque futuro o de hace más de 36 meses, saldo con 3 decimales; sin migración ⇒ 503', async () => {
    const { cuentas, tablas } = mundo();
    const dto = { cuenta_desde: '2026-09', saldo_inicial_usd: 0 };
    expect(
      await errorDe(cuentas.configurarCuenta(PILOTO, dto, ADMIN)),
    ).toMatchObject({
      status: 400,
      code: 'SOCIO_INVALIDO',
    });
    expect(
      await errorDe(
        cuentas.configurarCuenta(
          MAURICIO,
          { ...dto, cuenta_desde: '2026-11' },
          ADMIN,
        ),
      ),
    ).toMatchObject({ code: 'CUENTA_DESDE_FUTURA' });
    expect(
      await errorDe(
        cuentas.configurarCuenta(
          MAURICIO,
          { ...dto, cuenta_desde: '2023-10' },
          ADMIN,
        ),
      ),
    ).toMatchObject({ code: 'CUENTA_DESDE_FUERA_DE_RANGO' });
    expect(
      await errorDe(
        cuentas.configurarCuenta(
          MAURICIO,
          { ...dto, saldo_inicial_usd: 1.005 },
          ADMIN,
        ),
      ),
    ).toMatchObject({ code: 'SALDO_INICIAL_INVALIDO' });
    expect(tablas.reparto_cuenta_socio).toHaveLength(0);
    const sin = mundo({ sinMigracion: true });
    expect(
      await errorDe(sin.cuentas.configurarCuenta(MAURICIO, dto, ADMIN)),
    ).toMatchObject({
      status: 503,
      code: 'CUENTA_SOCIO_NO_DISPONIBLE',
      details: { migracion: '20261002000001' },
    });
  });

  it('Saab (PILOTO con % en N4142R) también tiene cuenta: el universo es aeronave_socio, no el rol', async () => {
    const { cuentas } = mundo();
    const r = await cuentas.configurarCuenta(
      SAAB,
      { cuenta_desde: '2026-09', saldo_inicial_usd: 0 },
      ADMIN,
    );
    expect(r).toMatchObject({
      socio: { id: SAAB, rol: 'PILOTO' },
      por_entregar_usd: 40.46,
    });
  });
});
