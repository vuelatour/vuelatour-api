import {
  aEventoMe,
  avisoEventoBase,
  cambiosRelevantes,
  claveRecordatorio90,
  claveVispera,
  cuerpoEvento,
  diaSiguienteCancun,
  enVentanaRecordatorio90,
  fechaHoraCancunCorta,
  horaCancun,
  isoAlMinuto,
  mapEventoRow,
  rangoDiaCancun,
  rangoMisEventos,
  sumarDias,
  ventanaRecordatorio90,
} from './evento-flota.util';

// Caso real del incidente: "Llenar Bitácora", 2026-09-03T14:45Z = 09:45 Cancún.
const EVENTO = {
  id: '2f084697-0000-4000-8000-000000000000',
  titulo: 'Llenar Bitácora',
  fecha: '2026-09-03T14:45:00.000Z',
  fecha_fin: null,
  aeronave_id: 'a1',
  aeronave_matricula: 'XA-VGV',
  notas: 'Está en la oficina ⚠️',
  responsable_id: 'luis',
};

describe('formato Cancún', () => {
  it('fechaHoraCancunCorta: "jue 3 sep, 09:45"', () => {
    expect(fechaHoraCancunCorta(EVENTO.fecha)).toMatch(/^jue 3 sept?, 09:45$/);
  });

  it('horaCancun usa reloj de 24 h sin "24:xx" a medianoche', () => {
    expect(horaCancun('2026-09-03T14:45:00Z')).toBe('09:45');
    expect(horaCancun('2026-09-03T05:05:00Z')).toBe('00:05');
    expect(horaCancun('2026-09-04T04:59:00Z')).toBe('23:59');
  });

  it('fecha inválida → error legible', () => {
    expect(() => horaCancun('nope')).toThrow(/Fecha inválida/);
  });
});

describe('cuerpoEvento', () => {
  it('lleva hora Cancún, título, matrícula y notas', () => {
    expect(cuerpoEvento(EVENTO)).toMatch(
      /^jue 3 sept?, 09:45 · Llenar Bitácora · XA-VGV · Está en la oficina ⚠️$/,
    );
  });

  it('omite los segmentos vacíos (sin avión ni notas)', () => {
    expect(
      cuerpoEvento({ ...EVENTO, aeronave_matricula: null, notas: '  ' }),
    ).toMatch(/^jue 3 sept?, 09:45 · Llenar Bitácora$/);
  });

  it('acepta encabezado propio (recordatorios)', () => {
    expect(
      cuerpoEvento(EVENTO, `En 90 min · ${horaCancun(EVENTO.fecha)}`),
    ).toBe(
      'En 90 min · 09:45 · Llenar Bitácora · XA-VGV · Está en la oficina ⚠️',
    );
    expect(cuerpoEvento(EVENTO, 'Mañana 09:45')).toBe(
      'Mañana 09:45 · Llenar Bitácora · XA-VGV · Está en la oficina ⚠️',
    );
  });
});

describe('avisoEventoBase', () => {
  it('data con fecha_dia Cancún y link a /me/eventos?dia=', () => {
    const a = avisoEventoBase(EVENTO);
    expect(a.link).toBe('/me/eventos?dia=2026-09-03');
    expect(a.data).toEqual({
      evento_id: EVENTO.id,
      titulo: 'Llenar Bitácora',
      fecha: '2026-09-03T14:45:00.000Z',
      fecha_dia: '2026-09-03',
      aeronave_id: 'a1',
      aeronave_matricula: 'XA-VGV',
      responsable_id: 'luis',
    });
  });

  it('a las 02:00Z el día Cancún sigue siendo el anterior', () => {
    expect(
      avisoEventoBase({ ...EVENTO, fecha: '2026-09-04T02:00:00Z' }).data
        .fecha_dia,
    ).toBe('2026-09-03');
  });
});

describe('mapEventoRow / aEventoMe', () => {
  it('desenvuelve embeds (objeto o arreglo) y proyecta el shape público', () => {
    const interno = mapEventoRow({
      id: 'e1',
      titulo: 'Lavado',
      fecha: '2026-09-03T14:45:00Z',
      fecha_fin: null,
      aeronave_id: 'a1',
      responsable_id: 'u1',
      notas: null,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
      created_by: 'itzi',
      google_calendar_id: 'g1',
      aeronave: [{ matricula: 'XA-VGV', color_calendario: '#123456' }],
      responsable: { nombre: 'Luis' },
      creador: [{ nombre: 'Itzi' }],
    });
    expect(interno.aeronave_matricula).toBe('XA-VGV');
    expect(interno.aeronave_color).toBe('#123456');
    expect(interno.responsable_nombre).toBe('Luis');
    expect(interno.creado_por_nombre).toBe('Itzi');
    expect(interno.google_calendar_id).toBe('g1');
    const publico = aEventoMe(interno);
    expect(Object.keys(publico).sort()).toEqual(
      [
        'aeronave_color',
        'aeronave_id',
        'aeronave_matricula',
        'creado_por_nombre',
        'created_at',
        'fecha',
        'fecha_fin',
        'id',
        'notas',
        'responsable_id',
        'titulo',
        'updated_at',
      ].sort(),
    );
  });
});

describe('cambiosRelevantes', () => {
  const base = {
    titulo: 'Llenar Bitácora',
    fecha: '2026-09-03T14:45:00Z',
    fecha_fin: null,
    aeronave_id: 'a1',
    notas: 'x',
  };
  it('mismo instante con otro formato no es cambio', () => {
    expect(
      cambiosRelevantes(base, { ...base, fecha: '2026-09-03T09:45:00-05:00' }),
    ).toBe(false);
  });
  it('detecta hora, fin, avión, título y notas', () => {
    expect(
      cambiosRelevantes(base, { ...base, fecha: '2026-09-03T15:00:00Z' }),
    ).toBe(true);
    expect(
      cambiosRelevantes(base, { ...base, fecha_fin: '2026-09-04T14:45:00Z' }),
    ).toBe(true);
    expect(cambiosRelevantes(base, { ...base, aeronave_id: null })).toBe(true);
    expect(cambiosRelevantes(base, { ...base, titulo: 'Otro' })).toBe(true);
    expect(cambiosRelevantes(base, { ...base, notas: null })).toBe(true);
    expect(cambiosRelevantes(base, { ...base, notas: ' x ' })).toBe(false);
  });
});

describe('rangos Cancún', () => {
  it('sumarDias cruza mes y año', () => {
    expect(sumarDias('2026-08-30', 3)).toBe('2026-09-02');
    expect(sumarDias('2026-01-03', -7)).toBe('2025-12-27');
  });

  it('rangoMisEventos default: hoy-7 → hoy+90 con cortes -05:00', () => {
    const r = rangoMisEventos(undefined, undefined, '2026-09-03');
    expect(r).toEqual({
      desde: '2026-08-27',
      hasta: '2026-12-02',
      desdeTs: '2026-08-27T00:00:00-05:00',
      hastaTs: '2026-12-02T23:59:59-05:00',
    });
  });

  it('rangoMisEventos respeta los días pedidos', () => {
    const r = rangoMisEventos('2026-09-01', '2026-09-30', '2026-09-03');
    expect(r.desdeTs).toBe('2026-09-01T00:00:00-05:00');
    expect(r.hastaTs).toBe('2026-09-30T23:59:59-05:00');
  });

  it('rangoDiaCancun de un solo día', () => {
    expect(rangoDiaCancun('2026-09-04')).toEqual({
      desde: '2026-09-04',
      hasta: '2026-09-04',
      desdeTs: '2026-09-04T00:00:00-05:00',
      hastaTs: '2026-09-04T23:59:59-05:00',
    });
  });
});

describe('recordatorios', () => {
  const now = Date.parse('2026-09-03T13:15:00Z'); // 08:15 Cancún

  it('ventana de 90 min = [now+89, now+91]', () => {
    expect(ventanaRecordatorio90(now)).toEqual({
      desde: '2026-09-03T14:44:00.000Z',
      hasta: '2026-09-03T14:46:00.000Z',
    });
  });

  it('el evento de las 09:45 entra a las 08:15 (90 min antes) y no antes/después', () => {
    expect(enVentanaRecordatorio90(EVENTO.fecha, now)).toBe(true);
    expect(enVentanaRecordatorio90(EVENTO.fecha, now - 2 * 60_000)).toBe(false);
    expect(enVentanaRecordatorio90(EVENTO.fecha, now + 2 * 60_000)).toBe(false);
  });

  it('clave 90m cambia con la hora (reagendar vuelve a avisar)', () => {
    expect(isoAlMinuto('2026-09-03T09:45:30-05:00')).toBe('2026-09-03T14:45Z');
    expect(claveRecordatorio90(EVENTO.id, EVENTO.fecha)).toBe(
      `evento_90m:${EVENTO.id}:2026-09-03T14:45Z`,
    );
    expect(claveRecordatorio90(EVENTO.id, '2026-09-03T15:00:00Z')).not.toBe(
      claveRecordatorio90(EVENTO.id, EVENTO.fecha),
    );
  });

  it('clave de víspera por día', () => {
    expect(claveVispera(EVENTO.id, '2026-09-03')).toBe(
      `evento_vispera:${EVENTO.id}:2026-09-03`,
    );
  });

  it('diaSiguienteCancun a las 23:00Z del 2 (18:00 Cancún) es el 3', () => {
    expect(diaSiguienteCancun(new Date('2026-09-02T23:00:00Z'))).toBe(
      '2026-09-03',
    );
    // 00:30Z del 3 = 19:30 Cancún del 2 → mañana sigue siendo el 3.
    expect(diaSiguienteCancun(new Date('2026-09-03T00:30:00Z'))).toBe(
      '2026-09-03',
    );
  });
});
