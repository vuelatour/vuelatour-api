import { Rol } from '../../common/types/auth.types';
import {
  CODIGO_POR_PAGAR_FECHA_FUTURA,
  DETALLE_PRECIERRE_POR_PAGAR_SIN_VERIFICAR,
  DETALLE_PRECIERRE_SIN_POR_PAGAR,
  LINK_GASTOS_POR_PAGAR,
  MENSAJE_POR_PAGAR_CONCILIADO,
  MENSAJE_POR_PAGAR_FECHA_FUTURA,
  TITULO_PRECIERRE_GASTOS_POR_PAGAR,
  TITULO_RECORDATORIO_HOY,
  TITULO_RECORDATORIO_VENCIDO,
  anexarEstadoPago,
  celdaPagoExcel,
  claveRecordatorioPorPagar,
  conEstadoPago,
  cuerpoRecordatorioPorPagar,
  detallePrecierreGastosPorPagar,
  esMarcarPagado,
  esPatchSoloMarcarPagado,
  esRolCampo,
  estadoPagoGasto,
  fechaMarcarPagado,
  fechaMaxGasto,
  finDeMesCancun,
  mensajeFechaDespuesDeFinDeMes,
  porPagarFinal,
  porPagarVigente,
  resumenGastosPorPagar,
  sumarDias,
} from './por-pagar.util';

/**
 * GASTOS «POR PAGAR» (19-oct-2026, invariante 93): reglas PURAS (tope de
 * fecha por rol, bandera al escribir, estado de pago, «marcar pagado») y
 * TODOS los textos es-MX que el panel y la app enseñan tal cual.
 */
describe('por-pagar.util — fechas', () => {
  it.each([
    ['2026-10-19', '2026-10-31'],
    ['2026-10-31', '2026-10-31'],
    ['2026-11-01', '2026-11-30'],
    ['2026-12-15', '2026-12-31'],
    ['2026-02-10', '2026-02-28'],
    ['2028-02-10', '2028-02-29'], // bisiesto
    ['2100-02-10', '2100-02-28'], // múltiplo de 100: NO bisiesto
    ['2000-02-10', '2000-02-29'], // múltiplo de 400: bisiesto
  ])('finDeMesCancun(%s) ⇒ %s', (hoy, fin) => {
    expect(finDeMesCancun(hoy)).toBe(fin);
  });

  it('sumarDias cruza meses y años sin husos', () => {
    expect(sumarDias('2026-10-31', 1)).toBe('2026-11-01');
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-10-01', -1)).toBe('2026-09-30');
    expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29');
    expect(sumarDias('2026-10-19', 30)).toBe('2026-11-18');
  });

  it('esRolCampo: PILOTO, MECANICO y VISITANTE; la oficina no', () => {
    expect(esRolCampo(Rol.PILOTO)).toBe(true);
    expect(esRolCampo(Rol.MECANICO)).toBe(true);
    expect(esRolCampo(Rol.VISITANTE)).toBe(true);
    for (const r of [
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.ANALISTA,
      Rol.SOCIO,
    ]) {
      expect(esRolCampo(r)).toBe(false);
    }
    expect(esRolCampo(undefined)).toBe(false);
  });

  describe('fechaMaxGasto', () => {
    it('CAMPO con la migración ⇒ fin de mes', () => {
      expect(fechaMaxGasto('2026-10-19', Rol.PILOTO)).toBe('2026-10-31');
      expect(fechaMaxGasto('2026-10-19', Rol.MECANICO, true)).toBe(
        '2026-10-31',
      );
      expect(fechaMaxGasto('2026-10-19', Rol.VISITANTE)).toBe('2026-10-31');
    });

    it('el ÚLTIMO día del mes sigue aceptando mañana (como antes)', () => {
      expect(fechaMaxGasto('2026-10-31', Rol.PILOTO)).toBe('2026-11-01');
      expect(fechaMaxGasto('2026-10-30', Rol.PILOTO)).toBe('2026-10-31');
      expect(fechaMaxGasto('2028-02-29', Rol.PILOTO)).toBe('2028-03-01');
      expect(fechaMaxGasto('2026-12-31', Rol.PILOTO)).toBe('2027-01-01');
    });

    it('CAMPO sin la migración ⇒ mañana (lo de siempre)', () => {
      expect(fechaMaxGasto('2026-10-19', Rol.PILOTO, false)).toBe('2026-10-20');
      expect(fechaMaxGasto('2026-10-31', Rol.VISITANTE, false)).toBe(
        '2026-11-01',
      );
    });

    it('OFICINA ⇒ hoy + 30 con o sin la migración (sin cambio)', () => {
      for (const r of [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION]) {
        expect(fechaMaxGasto('2026-10-19', r)).toBe('2026-11-18');
        expect(fechaMaxGasto('2026-10-19', r, false)).toBe('2026-11-18');
      }
      expect(fechaMaxGasto('2026-10-19', undefined)).toBe('2026-11-18');
    });
  });

  it('texto EXACTO del 400 de campo después de fin de mes', () => {
    expect(mensajeFechaDespuesDeFinDeMes('2026-11-02', '2026-10-19')).toBe(
      'La fecha del gasto (02/11/2026) es después de fin de mes: los gastos por pagar se capturan a lo más hasta el último día del mes (31/10/2026).',
    );
  });
});

describe('por-pagar.util — porPagarFinal', () => {
  const HOY = '2026-10-19';

  it('fecha > hoy ⇒ true aunque no se mande, y con true', () => {
    expect(porPagarFinal({ fechaFinal: '2026-10-20', hoy: HOY })).toEqual({
      ok: true,
      por_pagar: true,
    });
    expect(
      porPagarFinal({ fechaFinal: '2026-10-31', hoy: HOY, enviado: true }),
    ).toEqual({ ok: true, por_pagar: true });
    expect(
      porPagarFinal({
        fechaFinal: '2026-10-20',
        hoy: HOY,
        vigente: false,
        enviado: null,
      }),
    ).toEqual({ ok: true, por_pagar: true });
  });

  it('fecha > hoy con `false` ⇒ 400 POR_PAGAR_FECHA_FUTURA con su texto', () => {
    expect(
      porPagarFinal({ fechaFinal: '2026-10-20', hoy: HOY, enviado: false }),
    ).toEqual({
      ok: false,
      error: {
        message:
          'Un gasto con fecha futura queda por pagar: márcalo pagado el día que lo pagues (la fecha del gasto es la del pago).',
        error: 'POR_PAGAR_FECHA_FUTURA',
        details: { fecha_gasto: '2026-10-20', hoy: HOY },
      },
    });
    expect(CODIGO_POR_PAGAR_FECHA_FUTURA).toBe('POR_PAGAR_FECHA_FUTURA');
    expect(MENSAJE_POR_PAGAR_FECHA_FUTURA).toContain('fecha futura');
  });

  it('fecha ≤ hoy ⇒ enviado ?? vigente ?? false', () => {
    const f = (enviado?: boolean | null, vigente?: boolean | null) =>
      porPagarFinal({ fechaFinal: HOY, hoy: HOY, enviado, vigente });
    expect(f()).toEqual({ ok: true, por_pagar: false });
    expect(f(true)).toEqual({ ok: true, por_pagar: true }); // «lo pago al rato»
    expect(f(false, true)).toEqual({ ok: true, por_pagar: false });
    expect(f(undefined, true)).toEqual({ ok: true, por_pagar: true });
    expect(f(null, false)).toEqual({ ok: true, por_pagar: false });
    expect(
      porPagarFinal({ fechaFinal: '2026-10-01', hoy: HOY, vigente: true }),
    ).toEqual({ ok: true, por_pagar: true }); // VENCIDO sigue por pagar
  });

  it('acepta un timestamp como fecha final (solo el día cuenta)', () => {
    expect(
      porPagarFinal({ fechaFinal: '2026-10-20T00:00:00Z', hoy: HOY }),
    ).toEqual({ ok: true, por_pagar: true });
  });

  describe('diaCaptura (alta que el outbox sube tarde)', () => {
    it('capturado con fecha a futuro y subido cuando ya pasó ⇒ sigue por pagar', () => {
      expect(
        porPagarFinal({
          fechaFinal: '2026-10-18',
          hoy: HOY,
          diaCaptura: '2026-10-17',
        }),
      ).toEqual({ ok: true, por_pagar: true });
    });

    it('`false` explícito manda (lo marcó pagado); `true` también', () => {
      expect(
        porPagarFinal({
          fechaFinal: '2026-10-18',
          hoy: HOY,
          diaCaptura: '2026-10-17',
          enviado: false,
        }),
      ).toEqual({ ok: true, por_pagar: false });
      expect(
        porPagarFinal({
          fechaFinal: '2026-10-18',
          hoy: HOY,
          diaCaptura: '2026-10-17',
          enviado: true,
        }),
      ).toEqual({ ok: true, por_pagar: true });
    });

    it('fecha ≤ día de captura ⇒ pagado (lo de siempre)', () => {
      expect(
        porPagarFinal({
          fechaFinal: '2026-10-17',
          hoy: HOY,
          diaCaptura: '2026-10-17',
        }),
      ).toEqual({ ok: true, por_pagar: false });
    });
  });
});

describe('por-pagar.util — estadoPagoGasto', () => {
  const HOY = '2026-10-19';

  it.each([
    [{ por_pagar: false, fecha_gasto: '2026-10-25' }, 'PAGADO'],
    [{ fecha_gasto: '2026-10-25' }, 'PAGADO'], // sin la llave (sin migración)
    [{ por_pagar: null, fecha_gasto: '2026-10-25' }, 'PAGADO'],
    [{ por_pagar: true, fecha_gasto: '2026-10-25' }, 'POR_PAGAR'],
    [{ por_pagar: true, fecha_gasto: '2026-10-19' }, 'POR_PAGAR'], // hoy
    [{ por_pagar: true, fecha_gasto: '2026-10-18' }, 'VENCIDO'],
    [{ por_pagar: true, fecha_gasto: '2026-09-30' }, 'VENCIDO'],
    // el banco prueba el pago aunque la columna siga en true
    [
      { por_pagar: true, conciliado: true, fecha_gasto: '2026-10-25' },
      'PAGADO',
    ],
    [
      { por_pagar: true, conciliado: true, fecha_gasto: '2026-10-01' },
      'PAGADO',
    ],
    [{ por_pagar: true, conciliado: false, fecha_gasto: null }, 'POR_PAGAR'],
    [{ por_pagar: 'true', fecha_gasto: '2026-10-25' }, 'PAGADO'], // solo boolean
  ])('%j ⇒ %s', (g, estado) => {
    expect(estadoPagoGasto(g, HOY)).toBe(estado);
    expect(porPagarVigente(g, HOY)).toBe(estado !== 'PAGADO');
  });

  it('conEstadoPago agrega `estado_pago` SOLO si la fila trae `por_pagar`', () => {
    const sin = { id: 'g', fecha_gasto: '2026-10-25' };
    expect(conEstadoPago(sin, HOY)).toBe(sin); // la MISMA fila: sin llave
    expect(
      conEstadoPago(
        { id: 'g', por_pagar: true, fecha_gasto: '2026-10-25' },
        HOY,
      ),
    ).toEqual({
      id: 'g',
      por_pagar: true,
      fecha_gasto: '2026-10-25',
      estado_pago: 'POR_PAGAR',
    });
    const filas: Array<Record<string, unknown>> = [
      { id: 'a', por_pagar: false, fecha_gasto: '2026-10-01' },
      { id: 'b', fecha_gasto: '2026-10-01' },
      { id: 'c', por_pagar: true, fecha_gasto: '2026-10-01' },
    ];
    anexarEstadoPago(filas, HOY);
    expect(filas.map((f) => f.estado_pago)).toEqual([
      'PAGADO',
      undefined,
      'VENCIDO',
    ]);
    expect('estado_pago' in filas[1]).toBe(false);
  });
});

describe('por-pagar.util — marcar pagado', () => {
  const HOY = '2026-10-19';

  it('esMarcarPagado: vigente por pagar + `false`', () => {
    expect(esMarcarPagado({ por_pagar: false }, { por_pagar: true })).toBe(
      true,
    );
    expect(esMarcarPagado({ por_pagar: false }, { por_pagar: false })).toBe(
      false,
    );
    expect(esMarcarPagado({}, { por_pagar: true })).toBe(false);
    expect(esMarcarPagado({ por_pagar: true }, { por_pagar: true })).toBe(
      false,
    );
    expect(esMarcarPagado({ por_pagar: false }, null)).toBe(false);
  });

  it('esPatchSoloMarcarPagado: solo por_pagar/fecha_gasto/if_updated_at/capturado_en', () => {
    expect(esPatchSoloMarcarPagado({ por_pagar: false })).toBe(true);
    expect(
      esPatchSoloMarcarPagado({
        por_pagar: false,
        fecha_gasto: '2026-10-19',
        if_updated_at: '2026-10-19T10:00:00Z',
        capturado_en: '2026-10-19T10:00:00Z',
      }),
    ).toBe(true);
    // llaves de la clase en undefined no cuentan (target ES2022)
    expect(
      esPatchSoloMarcarPagado({
        por_pagar: false,
        monto: undefined,
        notas: undefined,
      }),
    ).toBe(true);
    expect(esPatchSoloMarcarPagado({ por_pagar: false, monto: 500 })).toBe(
      false,
    );
    expect(esPatchSoloMarcarPagado({ por_pagar: false, notas: 'x' })).toBe(
      false,
    );
    expect(esPatchSoloMarcarPagado({ por_pagar: true })).toBe(false);
    expect(esPatchSoloMarcarPagado({ fecha_gasto: '2026-10-19' })).toBe(false);
  });

  it('fechaMarcarPagado: la enviada; si no, hoy (fecha futura) o la suya (vencido)', () => {
    expect(fechaMarcarPagado('2026-10-18', '2026-10-25', HOY)).toBe(
      '2026-10-18',
    );
    expect(fechaMarcarPagado(undefined, '2026-10-25', HOY)).toBe(HOY);
    expect(fechaMarcarPagado(null, '2026-10-19', HOY)).toBe(HOY);
    expect(fechaMarcarPagado(undefined, '2026-10-10', HOY)).toBe('2026-10-10');
    expect(fechaMarcarPagado('2026-10-17T12:00:00Z', '2026-10-25', HOY)).toBe(
      '2026-10-17',
    );
  });
});

describe('por-pagar.util — textos', () => {
  const HOY = '2026-10-19';

  it('celda «Pago» del Excel', () => {
    expect(
      celdaPagoExcel({ por_pagar: true, fecha_gasto: '2026-10-20' }, HOY),
    ).toBe('Por pagar · vence 20-oct-2026');
    expect(
      celdaPagoExcel({ por_pagar: true, fecha_gasto: '2026-10-19' }, HOY),
    ).toBe('Por pagar · vence 19-oct-2026');
    expect(
      celdaPagoExcel({ por_pagar: true, fecha_gasto: '2026-10-01' }, HOY),
    ).toBe('Vencido desde 1-oct-2026');
    expect(celdaPagoExcel({ por_pagar: false }, HOY)).toBe('');
    expect(
      celdaPagoExcel(
        { por_pagar: true, conciliado: true, fecha_gasto: '2026-10-20' },
        HOY,
      ),
    ).toBe('');
  });

  it('recordatorio: títulos, clave, link y cuerpo con fmtDineroTexto', () => {
    expect(TITULO_RECORDATORIO_HOY).toBe('Gasto por pagar hoy');
    expect(TITULO_RECORDATORIO_VENCIDO).toBe('Gasto por pagar vencido');
    expect(LINK_GASTOS_POR_PAGAR).toBe('/admin/expenses?por_pagar=1');
    expect(claveRecordatorioPorPagar('g-1', '2026-10-19')).toBe(
      'gasto_por_pagar:g-1:2026-10-19',
    );
    expect(
      cuerpoRecordatorioPorPagar({
        categoria: 'TAXI',
        monto: 500,
        moneda: 'MXN',
        folio: 436,
      }),
    ).toBe(
      'Taxi / estacionamiento · $500 MXN · vuelo #436 — cuando lo pagues, márcalo pagado (Mis registros en la app, o Gastos en el panel).',
    );
    expect(
      cuerpoRecordatorioPorPagar({
        categoria: 'COMIDA',
        monto: '1250.5',
        moneda: 'USD',
        folio: null,
      }),
    ).toBe(
      'Comida · $1,250.50 USD — cuando lo pagues, márcalo pagado (Mis registros en la app, o Gastos en el panel).',
    );
  });

  it('pre-cierre: título, resumen por moneda (jamás se suman) y detalle', () => {
    expect(TITULO_PRECIERRE_GASTOS_POR_PAGAR).toBe(
      'Gastos por pagar sin confirmar',
    );
    const r = resumenGastosPorPagar(
      [
        {
          monto: 500,
          moneda: 'MXN',
          por_pagar: true,
          fecha_gasto: '2026-10-25',
        },
        {
          monto: '250.25',
          moneda: 'MXN',
          por_pagar: true,
          fecha_gasto: '2026-10-01',
        },
        {
          monto: 100,
          moneda: 'USD',
          por_pagar: true,
          fecha_gasto: '2026-10-02',
        },
      ],
      HOY,
    );
    expect(r).toEqual({ n: 3, vencidos: 2, mxn: 750.25, usd: 100 });
    expect(detallePrecierreGastosPorPagar(r)).toBe(
      '3 gastos siguen «por pagar» (2 vencidos): márcalos pagados con la fecha real del pago, o elimínalos si no se pagaron.',
    );
    expect(
      detallePrecierreGastosPorPagar({ n: 1, vencidos: 1, mxn: 1, usd: 0 }),
    ).toBe(
      '1 gasto sigue «por pagar» (1 vencido): márcalo pagado con la fecha real del pago, o elimínalo si no se pagó.',
    );
    expect(
      detallePrecierreGastosPorPagar({ n: 2, vencidos: 0, mxn: 1, usd: 0 }),
    ).toBe(
      '2 gastos siguen «por pagar» (0 vencidos): márcalos pagados con la fecha real del pago, o elimínalos si no se pagaron.',
    );
    expect(
      detallePrecierreGastosPorPagar({ n: 0, vencidos: 0, mxn: 0, usd: 0 }),
    ).toBe(DETALLE_PRECIERRE_SIN_POR_PAGAR);
    expect(detallePrecierreGastosPorPagar(null)).toBe(
      DETALLE_PRECIERRE_POR_PAGAR_SIN_VERIFICAR,
    );
    expect(DETALLE_PRECIERRE_POR_PAGAR_SIN_VERIFICAR).toBe(
      'No se pudieron verificar los gastos por pagar del periodo.',
    );
  });

  it('409 al re-programar un gasto conciliado', () => {
    expect(MENSAJE_POR_PAGAR_CONCILIADO).toBe(
      'Este gasto ya está conciliado con el banco: el cargo es su pago y no se pone «por pagar». Si ese cargo no es su pago, desvincúlalo primero en Conciliación.',
    );
  });
});
