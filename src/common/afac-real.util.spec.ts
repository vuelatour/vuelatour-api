import { Rol } from './types/auth.types';
import {
  CATEGORIA_PAGO_AFAC,
  CONCEPTO_AFAC_REAL_POR_CAPTURAR,
  ETIQUETA_AVION_PAGO_AFAC,
  PAGO_AFAC_CLAVE_DETALLE,
  ROLES_AFAC_REAL,
  conceptoAfacReal,
  conceptoAfacReservado,
  esPagoAfac,
  fechaCortaCancun,
  notaAfacReservado,
  r2,
  rolCapturaAfac,
  validarCostoRealAfac,
} from './afac-real.util';

/**
 * Fuente ÚNICA de la marca «Pago de AFAC» y de los textos de la fila AFAC
 * por vuelo (16-oct-2026, invariante 90).
 */
describe('afac-real.util (invariante 90)', () => {
  it('esPagoAfac: SOLO PERMISO marcado (la BD lo garantiza; aquí es defensa)', () => {
    expect(CATEGORIA_PAGO_AFAC).toBe('PERMISO');
    expect(esPagoAfac({ categoria: 'PERMISO', es_pago_afac: true })).toBe(true);
    expect(esPagoAfac({ categoria: 'PERMISO', es_pago_afac: false })).toBe(
      false,
    );
    expect(esPagoAfac({ categoria: 'PERMISO' })).toBe(false);
    expect(esPagoAfac({ categoria: 'OTRO', es_pago_afac: true })).toBe(false);
    expect(esPagoAfac({ categoria: 'SERVICIOS', es_pago_afac: true })).toBe(
      false,
    );
    expect(esPagoAfac(null)).toBe(false);
    expect(esPagoAfac(undefined)).toBe(false);
  });

  it('roles de oficina: ADMIN, FACTURACION, COORDINADOR (ANALISTA ve sin editar)', () => {
    expect([...ROLES_AFAC_REAL]).toEqual([
      Rol.ADMIN,
      Rol.FACTURACION,
      Rol.COORDINADOR,
    ]);
    expect(rolCapturaAfac(Rol.COORDINADOR)).toBe(true);
    for (const r of [
      Rol.ANALISTA,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.SOCIO,
      Rol.VISITANTE,
    ]) {
      expect(rolCapturaAfac(r)).toBe(false);
    }
    expect(rolCapturaAfac(undefined)).toBe(false);
  });

  it('validarCostoRealAfac: cero o mayor, hasta 2 decimales, finito', () => {
    expect(validarCostoRealAfac(0)).toBe(0);
    expect(validarCostoRealAfac(4427.8)).toBe(4427.8);
    expect(validarCostoRealAfac(4427.85)).toBe(4427.85);
    expect(validarCostoRealAfac(0.1 + 0.2)).toBe(0.3);
    for (const malo of [
      -1,
      1.234,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '4427.80',
      null,
      undefined,
      1e15,
    ]) {
      expect(validarCostoRealAfac(malo)).toBeNull();
    }
  });

  it('textos de la fila: reservado con la cuenta, real con quién/cuándo (día Cancún), por capturar', () => {
    expect(
      conceptoAfacReservado({
        matricula: 'N621TX',
        horas: 2.6,
        tarifa: 100,
        tc: 17.03,
      }),
    ).toBe('AFAC reservado · N621TX · 2.60 h × 100.00 USD/hr × T.C. 17.030000');
    // Horas con 2 decimales en el TEXTO (el valor viaja exacto).
    expect(
      conceptoAfacReservado({
        matricula: 'N4142R',
        horas: 0.7895,
        tarifa: 100,
        tc: 17,
      }),
    ).toContain('0.79 h');
    expect(
      conceptoAfacReservado({
        matricula: 'X',
        horas: null,
        tarifa: 100,
        tc: 17,
      }),
    ).toBe('AFAC reservado · X');
    expect(
      notaAfacReservado({
        reservado: 1700,
        horas: 1,
        tarifa: 100,
        tc: 17,
        cierreMarca: 'Viene de septiembre 2026',
      }),
    ).toBe(
      'Reservado = tarifa AFAC del avión × T.C. de costos del vuelo × horas cobradas (columna PERMISO AFAC de la hoja de vuelos): 100.00 × 17.000000 × 1.00 = $1,700.00\nViene de septiembre 2026',
    );
    expect(conceptoAfacReal('Alejandra Pérez', '2026-10-16T19:05:00Z')).toBe(
      'AFAC costo real · capturó Alejandra el 16/10/2026',
    );
    expect(conceptoAfacReal(null, null)).toBe(
      'AFAC costo real · capturó la oficina',
    );
    expect(fechaCortaCancun('2026-10-17T04:59:00Z')).toBe('16/10/2026');
    expect(fechaCortaCancun('basura')).toBeNull();
    expect(CONCEPTO_AFAC_REAL_POR_CAPTURAR).toBe(
      'AFAC costo real · por capturar',
    );
  });

  it('clave del reparto y etiqueta de Gastos (paridad con el panel); r2 nunca −0', () => {
    expect(PAGO_AFAC_CLAVE_DETALLE.startsWith('PERMISO')).toBe(true);
    expect(ETIQUETA_AVION_PAGO_AFAC).toBe('VuelaTour · pago de AFAC');
    expect(Object.is(r2(-0.001), 0)).toBe(true);
    expect(r2(4427.8 - 4500)).toBe(-72.2);
  });
});
