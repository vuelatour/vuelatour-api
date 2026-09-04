import {
  CAMPOS_NO_CLONABLES,
  patchCobrosAlClon,
  payloadClonVuelo,
} from './clon-vuelo.util';

describe('payloadClonVuelo (reassignAircraft)', () => {
  const original = {
    id: 'v-orig',
    folio: 120,
    cliente_id: 'cli-1',
    aeronave_id: 'av-vieja',
    estado: 'CONFIRMADO',
    grupo_id: 'g-1',
    grupo_posicion: 3,
    grupo_pax: 10,
    combinado_con_id: 'v-otro',
    pago_anticipado_req: false,
    google_calendar_id: 'gcal',
    foto_plan_vuelo_url: 'x.pdf',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    notas_internas: 'nota previa',
    calculo_snapshot: { meta: { grupo: { id: 'g-1', posicion: 3 } } },
  };

  it('conserva la liga de GRUPO (grupo_id / grupo_posicion / grupo_pax) y el snapshot', () => {
    const c = payloadClonVuelo(original, {
      aeronaveId: 'av-nueva',
      userId: 'u-1',
      matricula: 'N4142R',
    });
    expect(c.grupo_id).toBe('g-1');
    expect(c.grupo_posicion).toBe(3);
    expect(c.grupo_pax).toBe(10);
    expect(c.calculo_snapshot).toEqual(original.calculo_snapshot);
    expect(c.aeronave_id).toBe('av-nueva');
    expect(c.created_by).toBe('u-1');
    expect(c.updated_by).toBe('u-1');
    expect(c.notas_internas).toBe(
      'nota previa\nReasignado desde el vuelo #120 (cambio de aeronave a N4142R).',
    );
  });

  it('retira exactamente lo no clonable (id, folio, fechas, google, foto, combinación, generada)', () => {
    const c = payloadClonVuelo(original, {
      aeronaveId: 'av-nueva',
      userId: 'u-1',
      matricula: 'N4142R',
    });
    for (const k of CAMPOS_NO_CLONABLES) expect(c).not.toHaveProperty(k);
    // Y la lista de exclusión NO incluye la liga de grupo (regla del diseño).
    for (const k of ['grupo_id', 'grupo_posicion', 'grupo_pax']) {
      expect(CAMPOS_NO_CLONABLES).not.toContain(k);
    }
  });
});

describe('patchCobrosAlClon (cobros del original → clon)', () => {
  it('solo toca vuelo_id: cobro_grupo_id / grupo_factor / client_request_id se conservan', () => {
    const patch = patchCobrosAlClon('v-clon');
    expect(patch).toEqual({ vuelo_id: 'v-clon' });
    expect(Object.keys(patch)).toEqual(['vuelo_id']);
    const parteDeSobre = {
      id: 'c-1',
      vuelo_id: 'v-orig',
      cobro_grupo_id: 'sobre-1',
      grupo_factor: 0.190741,
      client_request_id: null,
    };
    expect({ ...parteDeSobre, ...patch }).toEqual({
      ...parteDeSobre,
      vuelo_id: 'v-clon',
    });
  });
});
