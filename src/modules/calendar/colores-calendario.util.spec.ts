import {
  CANCELADO_COLOR,
  DESCANSO_COLOR,
  EVENTO_COLOR,
  EXTERNO_COLOR,
  MANTENIMIENTO_PROGRAMADO_COLOR,
  MANTENIMIENTO_TALLER_COLOR,
  PERMISO_PENDIENTE_COLOR,
  SIN_ASIGNAR_COLOR,
  SIN_AVION_COLOR,
  TENTATIVO_COLOR,
  colorEventoFlotaSistema,
  colorMantenimientoSistema,
  colorVueloSistema,
  vueloSinAsignar,
} from './colores-calendario.util';

/**
 * PALETA ÚNICA del calendario (12-sep-2026). Estos hex son los que el panel y
 * la app ya pintaban dentro de `calendar.service`: el refactor los movió a una
 * util para que el espejo a Google use LOS MISMOS. Cambiar uno cambia lo que
 * ve el cliente en las tres superficies, así que quedan congelados aquí.
 */
describe('paleta del calendario del sistema', () => {
  it('los hex son EXACTAMENTE los que ya usaba el calendario', () => {
    expect({
      CANCELADO_COLOR,
      TENTATIVO_COLOR,
      SIN_ASIGNAR_COLOR,
      PERMISO_PENDIENTE_COLOR,
      EXTERNO_COLOR,
      SIN_AVION_COLOR,
      DESCANSO_COLOR,
      EVENTO_COLOR,
      MANTENIMIENTO_PROGRAMADO_COLOR,
      MANTENIMIENTO_TALLER_COLOR,
    }).toEqual({
      CANCELADO_COLOR: '#EF4444',
      TENTATIVO_COLOR: '#64748B',
      SIN_ASIGNAR_COLOR: '#8B5CF6',
      PERMISO_PENDIENTE_COLOR: '#F59E0B',
      EXTERNO_COLOR: '#F0DCDB',
      SIN_AVION_COLOR: '#9CA3AF',
      DESCANSO_COLOR: '#14B8A6',
      EVENTO_COLOR: '#0EA5E9',
      MANTENIMIENTO_PROGRAMADO_COLOR: '#F59E0B',
      MANTENIMIENTO_TALLER_COLOR: '#EF4444',
    });
  });
});

describe('vueloSinAsignar', () => {
  it('solo un vuelo PROPIO y CONFIRMADO al que le falta avión o piloto', () => {
    expect(vueloSinAsignar({ estado: 'CONFIRMADO', pilotoId: 'p' })).toBe(true);
    expect(vueloSinAsignar({ estado: 'CONFIRMADO', aeronaveId: 'a' })).toBe(
      true,
    );
    expect(
      vueloSinAsignar({ estado: 'CONFIRMADO', aeronaveId: 'a', pilotoId: 'p' }),
    ).toBe(false);
    // Externo: la tripulación y el avión son del operador.
    expect(vueloSinAsignar({ estado: 'CONFIRMADO', esExterno: true })).toBe(
      false,
    );
    // Una RESERVA todavía no anuncia pendientes (es un espacio apartado).
    expect(vueloSinAsignar({ estado: 'RESERVA' })).toBe(false);
    expect(vueloSinAsignar({ estado: 'CANCELADO' })).toBe(false);
  });
});

describe('colorVueloSistema (precedencia única)', () => {
  const base = {
    estado: 'CONFIRMADO',
    aeronaveId: 'a-1',
    pilotoId: 'p-1',
    colorAvion: '#10B981',
  };

  it('cancelado domina TODO (historial en rojo)', () => {
    expect(colorVueloSistema({ ...base, estado: 'CANCELADO' })).toBe(
      CANCELADO_COLOR,
    );
    // Tramo cancelado de un vuelo vivo: `cancelado` explícito.
    expect(
      colorVueloSistema({ ...base, cancelado: true, permisoPendiente: true }),
    ).toBe(CANCELADO_COLOR);
  });

  it('tentativo (RESERVA) va antes que los pendientes y que el avión', () => {
    expect(
      colorVueloSistema({ ...base, estado: 'RESERVA', permisoPendiente: true }),
    ).toBe(TENTATIVO_COLOR);
  });

  it('sin asignar > permiso pendiente > externo > avión', () => {
    expect(
      colorVueloSistema({ ...base, aeronaveId: null, permisoPendiente: true }),
    ).toBe(SIN_ASIGNAR_COLOR);
    expect(colorVueloSistema({ ...base, permisoPendiente: true })).toBe(
      PERMISO_PENDIENTE_COLOR,
    );
    expect(
      colorVueloSistema({
        estado: 'CONFIRMADO',
        esExterno: true,
        colorAvion: '#10B981',
      }),
    ).toBe(EXTERNO_COLOR);
    expect(colorVueloSistema(base)).toBe('#10B981');
  });

  it('vuelo propio asignado sin color de avión: el gris del sistema', () => {
    expect(colorVueloSistema({ ...base, colorAvion: null })).toBe(
      SIN_AVION_COLOR,
    );
  });
});

describe('colorMantenimientoSistema / colorEventoFlotaSistema', () => {
  it('mantenimiento: rojo EN_TALLER, ámbar PROGRAMADO', () => {
    expect(colorMantenimientoSistema(true)).toBe(MANTENIMIENTO_TALLER_COLOR);
    expect(colorMantenimientoSistema(false)).toBe(
      MANTENIMIENTO_PROGRAMADO_COLOR,
    );
  });

  it('evento de flota: manda el color del avión; sin avión, el azul cielo', () => {
    expect(colorEventoFlotaSistema('#F97316')).toBe('#F97316');
    expect(colorEventoFlotaSistema(null)).toBe(EVENTO_COLOR);
    expect(colorEventoFlotaSistema(undefined)).toBe(EVENTO_COLOR);
  });
});
