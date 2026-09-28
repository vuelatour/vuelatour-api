import {
  AYUDA_PENDIENTE,
  AYUDA_SERVICIO,
  CANCELADO_COLOR,
  CONFIRMADO_COLOR,
  DESCANSO_COLOR,
  ESTADOS_CONFIRMADOS,
  ESTADOS_TENTATIVOS,
  LEYENDA_SEMAFORO,
  NOTA_COLOR_AVION,
  PAGADO_COLOR,
  PENDIENTE_COLOR,
  SEMAFORO,
  SERVICIO_COLOR,
  TENTATIVO_COLOR,
  colorEventoFlotaSistema,
  colorMantenimientoSistema,
  colorVueloSistema,
  esEstadoTentativo,
  vueloPagado,
  vueloPendiente,
  vueloSinAsignar,
  type ParamsColorVuelo,
} from './colores-calendario.util';

/**
 * SEMÁFORO DE 7 COLORES (28-sep-2026; 6 desde el 24-sep-2026 y 5 desde el
 * 22-sep-2026, que a su vez sustituyó a la paleta de 10 hex del 12-sep-2026).
 * El cliente pidió «que en los calendarios no se vean tantos colores», que
 * `aeronave.color_calendario` quede SOLO para los Excel del balance, —el
 * 24-sep— «cambiar el color del descanso y agregar el de cobrado» y —el
 * 28-sep— «los vuelos de Servicio, poner en color Café». Estos hex son los
 * que pintan el panel, la app y —traducidos— el Google Calendar de la
 * oficina: cambiar uno cambia las tres superficies, así que quedan congelados
 * aquí.
 */
describe('semáforo del calendario', () => {
  it('son EXACTAMENTE siete colores y estos hex', () => {
    expect(SEMAFORO).toEqual({
      TENTATIVO: '#64748B',
      PENDIENTE: '#F59E0B',
      CONFIRMADO: '#22C55E',
      PAGADO: '#3B82F6',
      CANCELADO: '#EF4444',
      DESCANSO: '#8B5CF6',
      SERVICIO: '#8B5E3C',
    });
    // Los alias con nombre son los MISMOS valores (nadie define un hex propio).
    expect({
      TENTATIVO_COLOR,
      CONFIRMADO_COLOR,
      PENDIENTE_COLOR,
      PAGADO_COLOR,
      CANCELADO_COLOR,
      DESCANSO_COLOR,
      SERVICIO_COLOR,
    }).toEqual({
      TENTATIVO_COLOR: SEMAFORO.TENTATIVO,
      CONFIRMADO_COLOR: SEMAFORO.CONFIRMADO,
      PENDIENTE_COLOR: SEMAFORO.PENDIENTE,
      PAGADO_COLOR: SEMAFORO.PAGADO,
      CANCELADO_COLOR: SEMAFORO.CANCELADO,
      DESCANSO_COLOR: SEMAFORO.DESCANSO,
      SERVICIO_COLOR: SEMAFORO.SERVICIO,
    });
    // Ningún color se repite: el semáforo tiene que poder leerse.
    expect(new Set(Object.values(SEMAFORO)).size).toBe(7);
  });

  /**
   * El CAFÉ (28-sep-2026) es del vuelo de SERVICIO y de nadie más. Ojo: el
   * morado del descanso (#8B5CF6) y el café (#8B5E3C) comparten el «8B» del
   * rojo; son colores distintos.
   */
  it('el café #8B5E3C es del vuelo de SERVICIO', () => {
    expect(SEMAFORO.SERVICIO).toBe('#8B5E3C');
    expect(SERVICIO_COLOR).not.toBe(DESCANSO_COLOR);
  });

  /**
   * El azul CAMBIÓ DE DUEÑO el 24-sep-2026: era del descanso y ahora es del
   * PAGADO. Si alguien «regresa» el descanso al azul, este test lo dice.
   */
  it('el azul #3B82F6 es del PAGADO; el descanso es MORADO #8B5CF6', () => {
    expect(SEMAFORO.PAGADO).toBe('#3B82F6');
    expect(SEMAFORO.DESCANSO).toBe('#8B5CF6');
    expect(DESCANSO_COLOR).not.toBe('#3B82F6');
  });

  it('la LEYENDA va en el ORDEN del cliente y con sus textos (panel y app la copian)', () => {
    // Lista literal del cliente (24-sep-2026): «Tentativo - Gris · Pendiente
    // (permiso) - Amarillo · Confirmado - Verde · Pagado - Azul · Cancelado -
    // Rojo · Descanso - Morado»; y al final, el café del 28-sep-2026.
    expect(LEYENDA_SEMAFORO).toEqual([
      { color: '#64748B', etiqueta: 'Tentativo' },
      {
        color: '#F59E0B',
        etiqueta: 'Pendiente (permiso)',
        ayuda:
          'Permiso de pista pendiente. También se pinta así el vuelo confirmado que todavía no tiene avión o piloto asignado.',
      },
      { color: '#22C55E', etiqueta: 'Confirmado' },
      { color: '#3B82F6', etiqueta: 'Pagado' },
      { color: '#EF4444', etiqueta: 'Cancelado' },
      { color: '#8B5CF6', etiqueta: 'Descanso 💤' },
      {
        color: '#8B5E3C',
        etiqueta: 'Servicio (taller / parada técnica)',
        ayuda:
          'Vuelo sin pasajeros con parada de servicio: no es del cliente y no se cotiza.',
      },
    ]);
    // Un renglón por color del semáforo: ni falta ni sobra ninguno.
    expect(new Set(LEYENDA_SEMAFORO.map((r) => r.color))).toEqual(
      new Set(Object.values(SEMAFORO)),
    );
    // El tooltip del amarillo avisa lo que la etiqueta no dice.
    expect(AYUDA_PENDIENTE).toContain('avión o piloto');
    expect(LEYENDA_SEMAFORO[1].ayuda).toBe(AYUDA_PENDIENTE);
    // El tooltip del café dice QUÉ vuelo es de servicio (la etiqueta sola se
    // confundiría con el mantenimiento, que sigue amarillo).
    expect(LEYENDA_SEMAFORO[6].ayuda).toBe(AYUDA_SERVICIO);
    expect(AYUDA_SERVICIO).toContain('sin pasajeros');
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

describe('vueloPagado (24-sep-2026)', () => {
  it('pagado = `vuelo.cobrado` (la bandera de refreshCobradoFlag), no se recalcula', () => {
    expect(vueloPagado({ cobrado: true })).toBe(true);
    expect(vueloPagado({ cobrado: true, montoTotalUsd: '4200.00' })).toBe(true);
    expect(vueloPagado({ cobrado: true, montoTotalUsd: 1 })).toBe(true);
    // Ausente / false / null = no pagado.
    expect(vueloPagado({})).toBe(false);
    expect(vueloPagado({ cobrado: false, montoTotalUsd: 4200 })).toBe(false);
    expect(vueloPagado({ cobrado: null })).toBe(false);
  });

  it('un vuelo en $0 (cliente interno, sin cotizar) NUNCA es pagado', () => {
    for (const montoTotalUsd of [0, '0', '0.00', -5, 'basura']) {
      expect(vueloPagado({ cobrado: true, montoTotalUsd })).toBe(false);
    }
    // Sin total a la mano se confía en la bandera (que ya exige total > 0).
    expect(vueloPagado({ cobrado: true, montoTotalUsd: null })).toBe(true);
    expect(vueloPagado({ cobrado: true, montoTotalUsd: '' })).toBe(true);
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
  /**
   * La precedencia COMPLETA de un vuelo o tramo (28-sep-2026), congelada en
   * una tabla: cancelado > SERVICIO > tentativo > pendiente > PAGADO >
   * confirmado.
   */
  it('precedencia completa con el PAGADO', () => {
    const firme = {
      estado: 'COMPLETADO',
      aeronaveId: 'a-1',
      pilotoId: 'p-1',
      montoTotalUsd: '4200.00',
    };
    const casos: ReadonlyArray<readonly [string, ParamsColorVuelo, string]> = [
      ['pagado y COMPLETADO ⇒ azul', { ...firme, cobrado: true }, '#3B82F6'],
      [
        'pagado y CONFIRMADO ⇒ azul',
        { ...firme, estado: 'CONFIRMADO', cobrado: true },
        '#3B82F6',
      ],
      [
        'pagado y EN_VUELO ⇒ azul',
        { ...firme, estado: 'EN_VUELO', cobrado: true },
        '#3B82F6',
      ],
      ['sin cobrar ⇒ verde', { ...firme, cobrado: false }, '#22C55E'],
      // El pendiente operativo NO se esconde detrás del dinero.
      [
        'pagado + permiso pendiente ⇒ amarillo',
        {
          ...firme,
          estado: 'CONFIRMADO',
          cobrado: true,
          permisoPendiente: true,
        },
        '#F59E0B',
      ],
      [
        'pagado + sin piloto ⇒ amarillo',
        { ...firme, estado: 'CONFIRMADO', cobrado: true, pilotoId: null },
        '#F59E0B',
      ],
      // Una RESERVA pagada por adelantado sigue sin estar en firme.
      [
        'RESERVA pagada ⇒ gris',
        { ...firme, estado: 'RESERVA', cobrado: true },
        '#64748B',
      ],
      [
        'COTIZADO pagado ⇒ gris',
        { ...firme, estado: 'COTIZADO', cobrado: true },
        '#64748B',
      ],
      // Cancelado con anticipo retenido del 100 %: historial en rojo.
      [
        'CANCELADO pagado ⇒ rojo',
        { ...firme, estado: 'CANCELADO', cobrado: true },
        '#EF4444',
      ],
      [
        'tramo cancelado de un vuelo pagado ⇒ rojo',
        { ...firme, cobrado: true, cancelado: true },
        '#EF4444',
      ],
      // $0 / interno: nunca azul aunque una fila vieja traiga cobrado=true.
      [
        '$0 con cobrado=true ⇒ verde',
        { ...firme, cobrado: true, montoTotalUsd: 0 },
        '#22C55E',
      ],
      [
        'externo pagado ⇒ azul (se pinta por su estado y su cobro)',
        {
          estado: 'CONFIRMADO',
          esExterno: true,
          cobrado: true,
          montoTotalUsd: 900,
        },
        '#3B82F6',
      ],
      // SERVICIO (28-sep-2026): café, después del cancelado y ANTES de todo
      // lo demás. Un vuelo de servicio nunca es «pagado» ni «tentativo».
      ['servicio COMPLETADO ⇒ café', { ...firme, servicio: true }, '#8B5E3C'],
      [
        'servicio pagado ⇒ café (nunca azul)',
        { ...firme, servicio: true, cobrado: true },
        '#8B5E3C',
      ],
      [
        'servicio con permiso pendiente ⇒ café',
        {
          ...firme,
          estado: 'CONFIRMADO',
          servicio: true,
          permisoPendiente: true,
        },
        '#8B5E3C',
      ],
      [
        'servicio sin piloto ⇒ café',
        { ...firme, estado: 'CONFIRMADO', servicio: true, pilotoId: null },
        '#8B5E3C',
      ],
      [
        'servicio RESERVA ⇒ café (no es un espacio del cliente)',
        { ...firme, estado: 'RESERVA', servicio: true },
        '#8B5E3C',
      ],
      [
        'servicio CANCELADO ⇒ rojo (el cancelado sigue dominando)',
        { ...firme, estado: 'CANCELADO', servicio: true },
        '#EF4444',
      ],
      [
        'tramo cancelado de un vuelo de servicio ⇒ rojo',
        { ...firme, servicio: true, cancelado: true },
        '#EF4444',
      ],
      [
        'servicio=false ⇒ la precedencia de siempre (verde)',
        { ...firme, servicio: false },
        '#22C55E',
      ],
      [
        'servicio=null ⇒ la precedencia de siempre (azul si pagado)',
        { ...firme, servicio: null, cobrado: true },
        '#3B82F6',
      ],
    ];
    for (const [nombre, params, hex] of casos) {
      expect([nombre, colorVueloSistema(params)]).toEqual([nombre, hex]);
    }
  });

  it('`vueloPagado` sigue siendo el DATO aunque el vuelo sea de servicio', () => {
    // El café gana el COLOR; el dato «cobrado completo» no se toca.
    expect(
      vueloPagado({ servicio: true, cobrado: true, montoTotalUsd: 100 }),
    ).toBe(true);
  });

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

  it('confirmado (verde) es el default: lo que no cae en un cubo anterior está en firme (y no está pagado)', () => {
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
