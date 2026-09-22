import {
  CANCELADO_COLOR,
  CONFIRMADO_COLOR,
  DESCANSO_COLOR,
  ESTADOS_CONFIRMADOS,
  ESTADOS_TENTATIVOS,
  LEYENDA_SEMAFORO,
  NOTA_COLOR_AVION,
  PENDIENTE_COLOR,
  SEMAFORO,
  TENTATIVO_COLOR,
  colorEventoFlotaSistema,
  colorMantenimientoSistema,
  colorVueloSistema,
  esEstadoTentativo,
  vueloPendiente,
  vueloSinAsignar,
} from './colores-calendario.util';

/**
 * SEMÁFORO DE 5 COLORES (22-sep-2026). Sustituye a la paleta de 10 hex del
 * 12-sep-2026: el cliente pidió «que en los calendarios no se vean tantos
 * colores» y que `aeronave.color_calendario` quede SOLO para los Excel del
 * balance. Estos hex son los que pintan el panel, la app y —traducidos— el
 * Google Calendar de la oficina: cambiar uno cambia las tres superficies, así
 * que quedan congelados aquí.
 */
describe('semáforo del calendario', () => {
  it('son EXACTAMENTE cinco colores y estos hex', () => {
    expect(SEMAFORO).toEqual({
      TENTATIVO: '#64748B',
      CONFIRMADO: '#22C55E',
      PENDIENTE: '#F59E0B',
      CANCELADO: '#EF4444',
      DESCANSO: '#3B82F6',
    });
    // Los alias con nombre son los MISMOS valores (nadie define un hex propio).
    expect({
      TENTATIVO_COLOR,
      CONFIRMADO_COLOR,
      PENDIENTE_COLOR,
      CANCELADO_COLOR,
      DESCANSO_COLOR,
    }).toEqual({
      TENTATIVO_COLOR: SEMAFORO.TENTATIVO,
      CONFIRMADO_COLOR: SEMAFORO.CONFIRMADO,
      PENDIENTE_COLOR: SEMAFORO.PENDIENTE,
      CANCELADO_COLOR: SEMAFORO.CANCELADO,
      DESCANSO_COLOR: SEMAFORO.DESCANSO,
    });
    // Ningún color se repite: el semáforo tiene que poder leerse.
    expect(new Set(Object.values(SEMAFORO)).size).toBe(5);
  });

  it('la LEYENDA va en este orden y con estos textos (panel y app la copian)', () => {
    expect(LEYENDA_SEMAFORO).toEqual([
      { color: '#64748B', etiqueta: 'Tentativo' },
      { color: '#22C55E', etiqueta: 'Confirmado' },
      { color: '#F59E0B', etiqueta: 'Permiso o asunto pendiente' },
      { color: '#EF4444', etiqueta: 'Cancelado' },
      { color: '#3B82F6', etiqueta: 'Descanso 💤' },
    ]);
    expect(NOTA_COLOR_AVION).toBe(
      'El color de cada avión ya no se usa en el calendario: se conserva para los reportes de Excel (balance individual y general).',
    );
  });
});

describe('esEstadoTentativo', () => {
  it('TODO estado anterior a CONFIRMADO es tentativo (no solo RESERVA)', () => {
    // El enum real `public.estado_vuelo`, en su orden: RESERVA → SOLICITUD →
    // COTIZADO → CONFIRMADO → EN_VUELO → COMPLETADO → CANCELADO.
    expect(ESTADOS_TENTATIVOS).toEqual(['RESERVA', 'SOLICITUD', 'COTIZADO']);
    expect(ESTADOS_CONFIRMADOS).toEqual([
      'CONFIRMADO',
      'EN_VUELO',
      'COMPLETADO',
    ]);
    for (const e of ESTADOS_TENTATIVOS) expect(esEstadoTentativo(e)).toBe(true);
    for (const e of [...ESTADOS_CONFIRMADOS, 'CANCELADO'])
      expect(esEstadoTentativo(e)).toBe(false);
    expect(esEstadoTentativo(null)).toBe(false);
    expect(esEstadoTentativo(undefined)).toBe(false);
  });
});

describe('vueloSinAsignar / vueloPendiente', () => {
  it('`sin_asignar` NO cambió de semántica (la app la lee tal cual)', () => {
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

  it('pendiente = permiso de pista PENDIENTE o falta avión/piloto', () => {
    expect(
      vueloPendiente({ estado: 'CONFIRMADO', permisoPendiente: true }),
    ).toBe(true);
    expect(vueloPendiente({ estado: 'CONFIRMADO', aeronaveId: 'a' })).toBe(
      true,
    );
    expect(
      vueloPendiente({ estado: 'CONFIRMADO', aeronaveId: 'a', pilotoId: 'p' }),
    ).toBe(false);
  });
});

describe('colorVueloSistema (precedencia única del semáforo)', () => {
  const base = {
    estado: 'CONFIRMADO',
    aeronaveId: 'a-1',
    pilotoId: 'p-1',
  };

  it('cancelado domina TODO (historial en rojo)', () => {
    expect(colorVueloSistema({ ...base, estado: 'CANCELADO' })).toBe(
      SEMAFORO.CANCELADO,
    );
    // Tramo cancelado de un vuelo vivo: `cancelado` explícito.
    expect(
      colorVueloSistema({ ...base, cancelado: true, permisoPendiente: true }),
    ).toBe(SEMAFORO.CANCELADO);
  });

  it('tentativo (gris) va antes que los pendientes, en TODO estado previo a CONFIRMADO', () => {
    for (const estado of ESTADOS_TENTATIVOS) {
      expect(colorVueloSistema({ ...base, estado })).toBe(SEMAFORO.TENTATIVO);
      expect(
        colorVueloSistema({ ...base, estado, permisoPendiente: true }),
      ).toBe(SEMAFORO.TENTATIVO);
    }
  });

  it('pendiente (amarillo): permiso de pista o falta avión/piloto', () => {
    expect(colorVueloSistema({ ...base, permisoPendiente: true })).toBe(
      SEMAFORO.PENDIENTE,
    );
    expect(colorVueloSistema({ ...base, aeronaveId: null })).toBe(
      SEMAFORO.PENDIENTE,
    );
    expect(colorVueloSistema({ ...base, pilotoId: null })).toBe(
      SEMAFORO.PENDIENTE,
    );
  });

  it('confirmado (verde) es el default: lo que no cae en un cubo anterior está en firme', () => {
    expect(colorVueloSistema(base)).toBe(SEMAFORO.CONFIRMADO);
    expect(colorVueloSistema({ ...base, estado: 'EN_VUELO' })).toBe(
      SEMAFORO.CONFIRMADO,
    );
    expect(colorVueloSistema({ ...base, estado: 'COMPLETADO' })).toBe(
      SEMAFORO.CONFIRMADO,
    );
  });

  it('el EXTERNO ya no tiene color propio: se pinta por su estado', () => {
    const externo = { esExterno: true, aeronaveId: null, pilotoId: null };
    expect(colorVueloSistema({ ...externo, estado: 'CONFIRMADO' })).toBe(
      SEMAFORO.CONFIRMADO,
    );
    expect(colorVueloSistema({ ...externo, estado: 'RESERVA' })).toBe(
      SEMAFORO.TENTATIVO,
    );
    expect(
      colorVueloSistema({
        ...externo,
        estado: 'CONFIRMADO',
        permisoPendiente: true,
      }),
    ).toBe(SEMAFORO.PENDIENTE);
  });

  /**
   * El corazón del pedido del 22-sep-2026: el color del avión salió de los
   * calendarios y se quedó SOLO en los Excel del balance. El campo sigue en
   * la interfaz (llamadores viejos) pero no puede mover ningún color.
   */
  it('`colorAvion` se IGNORA (quedó solo para los reportes de Excel)', () => {
    for (const colorAvion of ['#10B981', '#F97316', null, 'basura']) {
      expect(colorVueloSistema({ ...base, colorAvion })).toBe(
        SEMAFORO.CONFIRMADO,
      );
      expect(
        colorVueloSistema({ ...base, colorAvion, permisoPendiente: true }),
      ).toBe(SEMAFORO.PENDIENTE);
    }
  });
});

describe('colorMantenimientoSistema / colorEventoFlotaSistema', () => {
  it('mantenimiento: AMARILLO siempre (PROGRAMADO y EN_TALLER)', () => {
    expect(colorMantenimientoSistema(true)).toBe(SEMAFORO.PENDIENTE);
    expect(colorMantenimientoSistema(false)).toBe(SEMAFORO.PENDIENTE);
    expect(colorMantenimientoSistema()).toBe(SEMAFORO.PENDIENTE);
  });

  it('evento de flota: VERDE, con avión o sin él', () => {
    expect(colorEventoFlotaSistema('#F97316')).toBe(SEMAFORO.CONFIRMADO);
    expect(colorEventoFlotaSistema(null)).toBe(SEMAFORO.CONFIRMADO);
    expect(colorEventoFlotaSistema()).toBe(SEMAFORO.CONFIRMADO);
  });
});
