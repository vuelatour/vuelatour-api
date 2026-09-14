import {
  cuentaComoSinFacturar,
  esNoFacturable,
  estaPorFacturar,
  etiquetaFacturacion,
  filtroFacturacion,
  MENSAJE_NO_FACTURABLE_SIN_MIGRACION,
  mensajeNoFacturableSinMigracion,
} from './facturacion-gasto.util';

describe('facturacion-gasto.util (NO_FACTURABLE, 14-sep-2026)', () => {
  it('etiquetas: NO_FACTURABLE se lee "No requiere factura"', () => {
    expect(etiquetaFacturacion('PENDIENTE')).toBe('Pendiente');
    expect(etiquetaFacturacion('SOLICITADA')).toBe('Solicitada');
    expect(etiquetaFacturacion('FACTURADA')).toBe('Facturada');
    expect(etiquetaFacturacion('NO_FACTURABLE')).toBe('No requiere factura');
    // Código viejo/desconocido: se devuelve tal cual, nunca vacío en silencio.
    expect(etiquetaFacturacion('LO_QUE_SEA')).toBe('LO_QUE_SEA');
    expect(etiquetaFacturacion(null)).toBe('');
  });

  it('estaPorFacturar / esNoFacturable: NO_FACTURABLE no está por facturar', () => {
    expect(estaPorFacturar('PENDIENTE')).toBe(true);
    expect(estaPorFacturar('SOLICITADA')).toBe(true);
    expect(estaPorFacturar('FACTURADA')).toBe(false);
    expect(estaPorFacturar('NO_FACTURABLE')).toBe(false);
    expect(esNoFacturable('NO_FACTURABLE')).toBe(true);
    expect(esNoFacturable('PENDIENTE')).toBe(false);
  });

  describe('filtro NO_FACTURADA', () => {
    it('es un IN explícito (pendiente + solicitada), NO "distinto de FACTURADA"', () => {
      expect(filtroFacturacion('NO_FACTURADA')).toEqual({
        op: 'in',
        valores: ['PENDIENTE', 'SOLICITADA'],
      });
      // El bug que evita: con neq, un NO_FACTURABLE caía en la bandeja de
      // "falta por facturar" y no cuadraba con el conteo del pre-cierre.
      const f = filtroFacturacion('NO_FACTURADA');
      expect(f?.op === 'in' && f.valores.includes('NO_FACTURABLE')).toBe(false);
    });

    it('cualquier otro valor filtra por igualdad; vacío no filtra', () => {
      expect(filtroFacturacion('NO_FACTURABLE')).toEqual({
        op: 'eq',
        valor: 'NO_FACTURABLE',
      });
      expect(filtroFacturacion('FACTURADA')).toEqual({
        op: 'eq',
        valor: 'FACTURADA',
      });
      expect(filtroFacturacion(null)).toBeNull();
      expect(filtroFacturacion('')).toBeNull();
    });
  });

  describe('cuentaComoSinFacturar (pre-cierre)', () => {
    it('cuenta pendientes y solicitados', () => {
      expect(cuentaComoSinFacturar({ estatus_facturacion: 'PENDIENTE' })).toBe(
        true,
      );
      expect(cuentaComoSinFacturar({ estatus_facturacion: 'SOLICITADA' })).toBe(
        true,
      );
    });

    it('EXCLUYE facturados, NO_FACTURABLE, BODEGA y PERSONAL_DUENO', () => {
      expect(cuentaComoSinFacturar({ estatus_facturacion: 'FACTURADA' })).toBe(
        false,
      );
      expect(
        cuentaComoSinFacturar({ estatus_facturacion: 'NO_FACTURABLE' }),
      ).toBe(false);
      expect(
        cuentaComoSinFacturar({
          estatus_facturacion: 'PENDIENTE',
          medio_pago: 'BODEGA',
        }),
      ).toBe(false);
      expect(
        cuentaComoSinFacturar({
          estatus_facturacion: 'PENDIENTE',
          categoria: 'PERSONAL_DUENO',
        }),
      ).toBe(false);
    });
  });

  describe('tolerancia a la migración 20260914000002 sin aplicar', () => {
    const check23514 = {
      code: '23514',
      message:
        'new row for relation "gasto" violates check constraint "gasto_estatus_facturacion_check"',
    };

    it('23514 sobre estatus_facturacion con NO_FACTURABLE → mensaje de 400', () => {
      expect(mensajeNoFacturableSinMigracion(check23514, 'NO_FACTURABLE')).toBe(
        MENSAJE_NO_FACTURABLE_SIN_MIGRACION,
      );
      expect(MENSAJE_NO_FACTURABLE_SIN_MIGRACION).toMatch(/20260914000002/);
      expect(MENSAJE_NO_FACTURABLE_SIN_MIGRACION).toMatch(/Pendiente/);
    });

    it('otro CHECK, otro valor u otro código siguen su camino de siempre', () => {
      // CHECK de medio↔tarjeta: no es cosa de la migración.
      expect(
        mensajeNoFacturableSinMigracion(
          {
            code: '23514',
            message:
              'new row for relation "gasto" violates check constraint "gasto_check"',
          },
          'NO_FACTURABLE',
        ),
      ).toBeNull();
      // El PATCH no mandaba NO_FACTURABLE.
      expect(
        mensajeNoFacturableSinMigracion(check23514, 'PENDIENTE'),
      ).toBeNull();
      expect(mensajeNoFacturableSinMigracion(check23514, undefined)).toBeNull();
      // Otro código de error (FK).
      expect(
        mensajeNoFacturableSinMigracion(
          { code: '23503', message: 'estatus_facturacion' },
          'NO_FACTURABLE',
        ),
      ).toBeNull();
    });
  });
});
