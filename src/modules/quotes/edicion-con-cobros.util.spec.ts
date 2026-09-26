import {
  AVISO_EDICION_CON_COBROS_GRUPO,
  PREFIJO_MOTIVO_CON_COBROS,
  avisoEdicionConCobros,
  motivoConCobros,
  saldoTrasEdicion,
  textoQuienPuedeEditar,
} from './edicion-con-cobros.util';

/**
 * Textos del permiso especial `editores_cotizacion_cobrada` (26-sep-2026).
 * Casos REALES de prod: #305 (cotizada $754.00 con IVA por transferencia,
 * cobrada $600 en efectivo) y #317 ($2,893.04 cobrados en pesos a 17.5).
 */
describe('edicion-con-cobros.util', () => {
  it('prefijo del motivo: exacto y sin duplicarse', () => {
    expect(PREFIJO_MOTIVO_CON_COBROS).toBe('[Con cobros · permiso especial] ');
    expect(motivoConCobros('Sin IVA: se cobró en efectivo')).toBe(
      '[Con cobros · permiso especial] Sin IVA: se cobró en efectivo',
    );
    // Reintento o un panel que ya lo antepuso: no se repite.
    expect(motivoConCobros('[Con cobros · permiso especial] Sin IVA')).toBe(
      '[Con cobros · permiso especial] Sin IVA',
    );
    expect(motivoConCobros('  Corrección  ')).toBe(
      '[Con cobros · permiso especial] Corrección',
    );
  });

  it('saldo: una sola resta a centavos (saldo, exacto y sobrecobro)', () => {
    // #305 sin quitar el IVA: faltan $154.
    expect(saldoTrasEdicion(600, 754)).toEqual({
      cobrado_usd: 600,
      total_usd: 754,
      saldo_usd: 154,
      sobrecobro_usd: 0,
      redondeo_usd: 0,
    });
    // #305 re-cotizada sin IVA a $650: saldo $50.
    expect(saldoTrasEdicion(600, 650).saldo_usd).toBe(50);
    // Cuadra exacto (#317).
    expect(saldoTrasEdicion(2893.04, 2893.04)).toMatchObject({
      saldo_usd: 0,
      sobrecobro_usd: 0,
    });
    // Lo cobrado rebasa el total nuevo.
    expect(saldoTrasEdicion(600, 550.1)).toMatchObject({
      saldo_usd: 0,
      sobrecobro_usd: 49.9,
    });
    // Sin ruido de coma flotante (0.1 + 0.2).
    expect(saldoTrasEdicion(0.1 + 0.2, 0.3).saldo_usd).toBe(0);
  });

  it('aviso con saldo: cobrado, nuevo total y saldo, con moneda y nunca 1 decimal', () => {
    expect(avisoEdicionConCobros({ cobradoUsd: 600, totalUsd: 650.5 })).toBe(
      'Se editó con cobros registrados: cobrado $600 USD, nuevo total $650.50 USD, saldo $50.50 USD. Los cobros no se modificaron.',
    );
  });

  it('aviso con SOBRECOBRO cuando lo cobrado rebasa el total', () => {
    expect(avisoEdicionConCobros({ cobradoUsd: 600, totalUsd: 550.1 })).toBe(
      'Se editó con cobros registrados: cobrado $600 USD, nuevo total $550.10 USD, sobrecobro $49.90 USD. Los cobros no se modificaron.',
    );
  });

  it('aviso liquidado exacto: saldo $0', () => {
    expect(
      avisoEdicionConCobros({ cobradoUsd: 2893.04, totalUsd: 2893.04 }),
    ).toContain('saldo $0 USD.');
  });

  it('hasta $1 USD es REDONDEO en los dos sentidos (misma tolerancia que la bandera cobrado y el semáforo), y se dice', () => {
    // Revisión adversaria 26-sep-2026: con la resta exacta el aviso decía
    // «saldo $0.50 USD» mientras el semáforo pintaba «Pagado» y el diálogo
    // del panel «liquidada».
    expect(saldoTrasEdicion(600, 600.5)).toEqual({
      cobrado_usd: 600,
      total_usd: 600.5,
      saldo_usd: 0,
      sobrecobro_usd: 0,
      redondeo_usd: 0.5,
    });
    expect(avisoEdicionConCobros({ cobradoUsd: 600, totalUsd: 600.5 })).toBe(
      'Se editó con cobros registrados: cobrado $600 USD, nuevo total $600.50 USD, saldo $0 USD (diferencia de redondeo de $0.50 USD). Los cobros no se modificaron.',
    );
    // Cobrado apenas arriba del total: tampoco es sobrecobro.
    expect(saldoTrasEdicion(600.4, 600)).toMatchObject({
      saldo_usd: 0,
      sobrecobro_usd: 0,
      redondeo_usd: 0.4,
    });
    expect(
      avisoEdicionConCobros({ cobradoUsd: 600.4, totalUsd: 600 }),
    ).toContain('saldo $0 USD (diferencia de redondeo de $0.40 USD).');
    // Frontera: $1.00 exacto sigue siendo redondeo; $1.01 ya es saldo / sobrecobro.
    expect(saldoTrasEdicion(600, 601)).toMatchObject({
      saldo_usd: 0,
      redondeo_usd: 1,
    });
    expect(saldoTrasEdicion(600, 601.01)).toMatchObject({
      saldo_usd: 1.01,
      redondeo_usd: 0,
    });
    expect(saldoTrasEdicion(601.01, 600)).toMatchObject({
      sobrecobro_usd: 1.01,
      redondeo_usd: 0,
    });
  });

  it('cobros MXN sin tipo de cambio: se dicen aparte, jamás desaparecen', () => {
    const t = avisoEdicionConCobros({
      cobradoUsd: 0,
      totalUsd: 1000,
      sinTcCount: 1,
      sinTcMxn: 18000,
    });
    expect(t).toContain('saldo $1,000 USD');
    expect(t).toContain(
      'Además hay 1 cobro en MXN sin tipo de cambio ($18,000 MXN) que no entra en esta cuenta.',
    );
    expect(
      avisoEdicionConCobros({
        cobradoUsd: 10,
        totalUsd: 10,
        sinTcCount: 2,
        sinTcMxn: 1500.5,
      }),
    ).toContain(
      '2 cobros en MXN sin tipo de cambio ($1,500.50 MXN) que no entran',
    );
  });

  it('quién puede editarla: nombres limpios o nada', () => {
    expect(textoQuienPuedeEditar(['Alejandro Canales', 'Pablo Canales'])).toBe(
      ' Solo pueden editarla: Alejandro Canales, Pablo Canales.',
    );
    expect(textoQuienPuedeEditar([])).toBe('');
    expect(textoQuienPuedeEditar(['  ', ''])).toBe('');
  });

  it('aviso de grupo: nombra el camino («Re-partir»)', () => {
    expect(AVISO_EDICION_CON_COBROS_GRUPO).toContain('«Re-partir»');
  });
});
