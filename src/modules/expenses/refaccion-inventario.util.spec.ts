import { BadRequestException } from '@nestjs/common';
import {
  CODIGO_INVENTARIO,
  avisoCompraNoCreada,
  avisoCompraNoRecibida,
  avisoSalidaNoHecha,
  errorRefaccionInventario,
  lineaCompraDeRefaccion,
  mensajeDe,
  notasSalidaRefaccion,
  referenciaSalidaRefaccion,
  resultadoVacio,
} from './refaccion-inventario.util';

const inv = {
  nombre: 'Filtro de aceite CH48110',
  cantidad: 2,
  precio_venta: 450,
  precio_venta_moneda: 'MXN' as const,
};

describe('refacción a Inventario/Tienda (invariante 57): validación pura', () => {
  it('solo REFACCION; BODEGA no es una compra', () => {
    expect(
      errorRefaccionInventario({ categoria: 'OPERACIONES' }, inv)?.code,
    ).toBe(CODIGO_INVENTARIO.SOLO_REFACCION);
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION', medio_pago: 'BODEGA' },
        inv,
      )?.code,
    ).toBe(CODIGO_INVENTARIO.MEDIO_BODEGA);
  });

  it('ítem existente o nombre nuevo; cantidad > 0; precio ≥ 0 (0 = a costo)', () => {
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION' },
        { ...inv, nombre: '  ' },
      )?.code,
    ).toBe(CODIGO_INVENTARIO.ITEM_REQUERIDO);
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION' },
        { ...inv, nombre: null, item_id: 'a1b2' },
      ),
    ).toBeNull();
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION' },
        { ...inv, cantidad: 0 },
      )?.code,
    ).toBe(CODIGO_INVENTARIO.CANTIDAD_INVALIDA);
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION' },
        { ...inv, precio_venta: -1 },
      )?.code,
    ).toBe(CODIGO_INVENTARIO.PRECIO_INVALIDO);
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION' },
        { ...inv, precio_venta: 0 },
      ),
    ).toBeNull();
  });

  it('fecha FUTURA (gasto por pagar, revisión P12) ⇒ INVENTARIO_FECHA_FUTURA; solo si el llamador pasa `hoy`', () => {
    const futura = { categoria: 'REFACCION', fecha_gasto: '2026-10-20' };
    expect(errorRefaccionInventario(futura, inv, '2026-10-19')).toEqual({
      code: 'INVENTARIO_FECHA_FUTURA',
      message:
        'Una refacción con fecha futura queda «por pagar»: guárdala sin entrada a Inventario/Tienda y registra la entrada desde Inventario/Tienda (Compras) el día que llegue la pieza.',
    });
    expect(CODIGO_INVENTARIO.FECHA_FUTURA).toBe('INVENTARIO_FECHA_FUTURA');
    // Hoy o antes: entra (la pieza llegó). Sin `hoy` (sin la migración): no
    // se mide.
    expect(
      errorRefaccionInventario(
        { ...futura, fecha_gasto: '2026-10-19' },
        inv,
        '2026-10-19',
      ),
    ).toBeNull();
    expect(errorRefaccionInventario(futura, inv)).toBeNull();
    expect(errorRefaccionInventario(futura, inv, null)).toBeNull();
    // Un timestamp cuenta por su día.
    expect(
      errorRefaccionInventario(
        { ...futura, fecha_gasto: '2026-10-19T23:00:00' },
        inv,
        '2026-10-19',
      ),
    ).toBeNull();
    // Lo estructural va primero: otra categoría o BODEGA.
    expect(
      errorRefaccionInventario(
        { ...futura, categoria: 'OPERACIONES' },
        inv,
        '2026-10-19',
      )?.code,
    ).toBe(CODIGO_INVENTARIO.SOLO_REFACCION);
    expect(
      errorRefaccionInventario(
        { ...futura, medio_pago: 'BODEGA' },
        inv,
        '2026-10-19',
      )?.code,
    ).toBe(CODIGO_INVENTARIO.MEDIO_BODEGA);
  });

  it('«vender al avión» exige avión', () => {
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION' },
        { ...inv, vender_al_avion: true },
      )?.code,
    ).toBe(CODIGO_INVENTARIO.AVION_REQUERIDO);
    expect(
      errorRefaccionInventario(
        { categoria: 'REFACCION', aeronave_id: 'av-1' },
        { ...inv, vender_al_avion: true },
      ),
    ).toBeNull();
  });
});

describe('línea de compra y textos', () => {
  it('UNA línea: monto total ÷ unidades a 4 decimales; el ítem existente viaja por id y nombre', () => {
    expect(
      lineaCompraDeRefaccion(
        '1000.00',
        { cantidad: 3 },
        { nombre: 'Bujía REM38E' },
      ),
    ).toEqual({
      nombre: 'Bujía REM38E',
      cantidad: 3,
      costo_unitario: 333.3333,
    });
    expect(
      lineaCompraDeRefaccion(
        250,
        { cantidad: 1 },
        {
          item_id: 'it-1',
          nombre: 'Aceite 15W-50',
          numero_parte: 'AS-15W50',
          categoria: 'Lubricantes',
        },
      ),
    ).toEqual({
      item_id: 'it-1',
      nombre: 'Aceite 15W-50',
      numero_parte: 'AS-15W50',
      categoria: 'Lubricantes',
      cantidad: 1,
      costo_unitario: 250,
    });
    // Un monto ilegible no produce NaN: costo 0 (la compra se recibe a $0 y se corrige).
    expect(
      lineaCompraDeRefaccion('x', { cantidad: 2 }, { nombre: 'n' })
        .costo_unitario,
    ).toBe(0);
  });

  it('referencia, notas y avisos nombran la compra y dicen qué hacer', () => {
    expect(
      referenciaSalidaRefaccion('3f9a1c2e-0000-4000-8000-000000000000'),
    ).toBe('Gasto 3f9a1c2e');
    expect(notasSalidaRefaccion('Filtro', 2, '2026-10-12')).toContain(
      '2 × Filtro',
    );
    expect(avisoCompraNoCreada('sin conexión')).toContain('«Crear compra»');
    expect(avisoCompraNoRecibida(12, 'falta T.C.')).toContain(
      'compra #12 quedó ABIERTA',
    );
    expect(avisoSalidaNoHecha(null, 'stock')).toContain(
      'NO se vendió al avión',
    );
    expect(resultadoVacio()).toMatchObject({
      error: null,
      avisos: [],
      salida: null,
    });
  });

  it('mensajeDe lee el cuerpo de una HttpException y el message de un Error', () => {
    expect(
      mensajeDe(
        new BadRequestException('Compra en pesos: captura el tipo de cambio'),
      ),
    ).toBe('Compra en pesos: captura el tipo de cambio');
    expect(
      mensajeDe(new BadRequestException({ message: 'x', error: 'CODE' })),
    ).toBe('x');
    expect(mensajeDe(new Error('boom'))).toBe('boom');
    expect(mensajeDe('raro')).toBe('raro');
  });
});
