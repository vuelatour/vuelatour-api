import {
  AVISO_DIAS_DEFAULT,
  AVISO_HORAS_DEFAULT,
  compararPorUrgencia,
  diasEntre,
  diaValido,
  gravedadDeEstado,
  sumarMeses,
  vidaDeComponente,
  type DatosVidaComponente,
  type EstadoVida,
} from './componente-vida.util';

/**
 * VIDA DE UN COMPONENTE (17-nov-2026, API 0.0.140, invariante 135). Pedido
 * del cliente: «saber cuánto tiempo le queda a un foco, a una llanta». Aquí
 * se congelan las reglas: cada dimensión (horas / fecha), el peor de las dos,
 * los datos faltantes, el retirado congelado y la suma de meses con fin de
 * mes. El día de hoy y el Hobbs entran por parámetro (nada de reloj ni BD).
 */

/** Martes 17-nov-2026 (día de la captura del N990GG, Hobbs 5,599.4). */
const HOY = '2026-11-17';
const HOBBS = 5599.4;
const ctx = { hoy: HOY, horasAeronave: HOBBS };

const base: DatosVidaComponente = {
  estado: 'INSTALADO',
  fecha_instalacion: '2026-09-01',
  horas_aeronave_instalacion: 5500,
  horas_previas: 0,
  limite_horas: null,
  limite_meses: null,
  fecha_vencimiento: null,
  aviso_horas: 10,
  aviso_dias: 30,
  fecha_retiro: null,
  horas_aeronave_retiro: null,
};

describe('sumarMeses — mismo día o el último del mes destino', () => {
  it.each([
    ['2026-11-17', 12, '2027-11-17'],
    ['2026-11-17', 24, '2028-11-17'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2026-01-31', 1, '2026-02-28'], // el 31 no existe en febrero
    ['2028-01-31', 1, '2028-02-29'], // bisiesto
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-05-31', 6, '2026-11-30'],
    ['2026-08-31', 6, '2027-02-28'],
    ['2028-02-29', 12, '2029-02-28'],
    ['2026-01-15', 0, '2026-01-15'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-01-15', -2, '2025-11-15'],
    ['2026-01-31', 600, '2076-01-31'],
  ])('%s + %i meses = %s', (dia, meses, esperado) => {
    expect(sumarMeses(dia, meses)).toBe(esperado);
  });

  it('nunca desborda al mes siguiente (31-ene + 1 mes NO es 3-mar)', () => {
    expect(sumarMeses('2026-01-31', 1)).not.toBe('2026-03-03');
  });

  it('fecha inválida o meses no enteros ⇒ null', () => {
    expect(sumarMeses('2026-02-30', 1)).toBeNull();
    expect(sumarMeses('17/11/2026', 1)).toBeNull();
    expect(sumarMeses('2026-11-17', 1.5)).toBeNull();
  });
});

describe('diaValido / diasEntre', () => {
  it('solo acepta días reales YYYY-MM-DD (recorta un timestamp)', () => {
    expect(diaValido('2026-11-17')).toBe('2026-11-17');
    expect(diaValido('2026-11-17T08:00:00-05:00')).toBe('2026-11-17');
    expect(diaValido('2026-02-30')).toBeNull();
    expect(diaValido('2026-13-01')).toBeNull();
    expect(diaValido('')).toBeNull();
    expect(diaValido(null)).toBeNull();
    expect(diaValido(20261117)).toBeNull();
  });

  it('días de calendario, con signo', () => {
    expect(diasEntre('2026-11-17', '2026-11-17')).toBe(0);
    expect(diasEntre('2026-11-17', '2026-11-18')).toBe(1);
    expect(diasEntre('2026-11-17', '2026-11-16')).toBe(-1);
    expect(diasEntre('2026-11-17', '2027-11-17')).toBe(365);
    expect(diasEntre('2026-02-30', '2026-03-01')).toBeNull();
  });
});

describe('vidaDeComponente — sin límite («a condición»)', () => {
  it('dice cuánto lleva en servicio y no vence', () => {
    expect(vidaDeComponente(base, ctx)).toEqual({
      horas_en_servicio: 99.4,
      horas_restantes: null,
      vence_el: null,
      dias_restantes: null,
      dias_en_servicio: 77, // 1-sep → 17-nov
      estado: 'SIN_LIMITE',
      por: null,
      faltantes: [],
    });
  });

  it('sin ningún dato capturado: todo null, sin faltantes (no hay límite que calcular)', () => {
    expect(
      vidaDeComponente(
        {
          ...base,
          fecha_instalacion: null,
          horas_aeronave_instalacion: null,
        },
        ctx,
      ),
    ).toEqual({
      horas_en_servicio: null,
      horas_restantes: null,
      vence_el: null,
      dias_restantes: null,
      dias_en_servicio: null,
      estado: 'SIN_LIMITE',
      por: null,
      faltantes: [],
    });
  });
});

describe('vidaDeComponente — límite por HORAS', () => {
  const c = { ...base, limite_horas: 500 };

  it('vigente: en servicio = Hobbs − Hobbs al instalar', () => {
    const v = vidaDeComponente(c, ctx);
    expect(v).toMatchObject({
      horas_en_servicio: 99.4,
      horas_restantes: 400.6,
      estado: 'VIGENTE',
      por: 'HORAS',
      faltantes: [],
    });
    expect(v.vence_el).toBeNull();
    expect(v.dias_restantes).toBeNull();
  });

  it('las horas previas del componente (usado) cuentan', () => {
    const v = vidaDeComponente({ ...c, horas_previas: 12.25 }, ctx);
    expect(v.horas_en_servicio).toBe(111.65);
    expect(v.horas_restantes).toBe(388.35);
  });

  it('números que llegan como TEXTO de PostgREST dan lo mismo', () => {
    const v = vidaDeComponente(
      {
        ...c,
        limite_horas: '500.00',
        horas_aeronave_instalacion: '5500.00',
        horas_previas: '12.25',
        aviso_horas: '10.00',
      },
      ctx,
    );
    expect(v.horas_en_servicio).toBe(111.65);
    expect(v.horas_restantes).toBe(388.35);
    expect(v.estado).toBe('VIGENTE');
  });

  it.each<[number, number, EstadoVida]>([
    [5989.99, 10.01, 'VIGENTE'], // un pelo arriba del aviso
    [5990, 10, 'POR_VENCER'], // justo en el aviso
    [5990.5, 9.5, 'POR_VENCER'],
    [5999.9, 0.1, 'POR_VENCER'],
    [6000, 0, 'VENCIDO'], // llegó al límite
    [6003.2, -3.2, 'VENCIDO'], // vencido POR 3.2 h
  ])('Hobbs %d ⇒ le quedan %d h ⇒ %s', (hobbs, restantes, estado) => {
    const v = vidaDeComponente(c, { hoy: HOY, horasAeronave: hobbs });
    expect(v.horas_restantes).toBe(restantes);
    expect(v.estado).toBe(estado);
    expect(v.por).toBe('HORAS');
  });

  it('aviso de horas por omisión cuando viene null', () => {
    const v = vidaDeComponente(
      { ...c, aviso_horas: null },
      { hoy: HOY, horasAeronave: 5500 + 500 - AVISO_HORAS_DEFAULT },
    );
    expect(v.horas_restantes).toBe(AVISO_HORAS_DEFAULT);
    expect(v.estado).toBe('POR_VENCER');
  });

  it('aviso en 0: solo avisa al vencer', () => {
    const v = vidaDeComponente(
      { ...c, aviso_horas: 0 },
      { hoy: HOY, horasAeronave: 5999.9 },
    );
    expect(v.estado).toBe('VIGENTE');
  });

  it('Hobbs MENOR que el de instalación ⇒ 0 en servicio (nunca negativo)', () => {
    const v = vidaDeComponente(
      { ...c, horas_previas: 40 },
      { hoy: HOY, horasAeronave: 5400 },
    );
    expect(v.horas_en_servicio).toBe(40);
    expect(v.horas_restantes).toBe(460);
    expect(v.estado).toBe('VIGENTE');
  });

  it('falta el Hobbs al instalar ⇒ SIN_DATOS y lo dice', () => {
    expect(
      vidaDeComponente({ ...c, horas_aeronave_instalacion: null }, ctx),
    ).toMatchObject({
      horas_en_servicio: null,
      horas_restantes: null,
      estado: 'SIN_DATOS',
      por: 'HORAS',
      faltantes: ['horas_aeronave_instalacion'],
    });
  });

  it('no se conoce el Hobbs del avión ⇒ SIN_DATOS y lo dice', () => {
    expect(
      vidaDeComponente(c, { hoy: HOY, horasAeronave: null }),
    ).toMatchObject({
      horas_en_servicio: null,
      horas_restantes: null,
      estado: 'SIN_DATOS',
      por: 'HORAS',
      faltantes: ['horas_aeronave'],
    });
  });

  it('faltan los dos datos ⇒ los dos en faltantes', () => {
    expect(
      vidaDeComponente(
        { ...c, horas_aeronave_instalacion: null },
        { hoy: HOY, horasAeronave: null },
      ).faltantes,
    ).toEqual(['horas_aeronave_instalacion', 'horas_aeronave']);
  });
});

describe('vidaDeComponente — límite por FECHA', () => {
  it.each<[string, number, EstadoVida]>([
    ['2026-11-16', -1, 'VENCIDO'], // venció ayer
    ['2026-11-17', 0, 'POR_VENCER'], // vence HOY: todavía no está vencido
    ['2026-11-18', 1, 'POR_VENCER'],
    ['2026-12-17', 30, 'POR_VENCER'], // justo en el aviso
    ['2026-12-18', 31, 'VIGENTE'],
    ['2027-03-12', 115, 'VIGENTE'],
  ])('fecha exacta %s ⇒ %d días ⇒ %s', (fecha, dias, estado) => {
    const v = vidaDeComponente({ ...base, fecha_vencimiento: fecha }, ctx);
    expect(v.vence_el).toBe(fecha);
    expect(v.dias_restantes).toBe(dias);
    expect(v.estado).toBe(estado);
    expect(v.por).toBe('FECHA');
    expect(v.horas_restantes).toBeNull();
  });

  it('por meses: vence = instalación + meses', () => {
    const v = vidaDeComponente({ ...base, limite_meses: 12 }, ctx);
    expect(v.vence_el).toBe('2027-09-01');
    expect(v.dias_restantes).toBe(288);
    expect(v.estado).toBe('VIGENTE');
    expect(v.por).toBe('FECHA');
  });

  it('por meses con fin de mes: 31-ago + 6 meses = 28-feb', () => {
    const v = vidaDeComponente(
      { ...base, fecha_instalacion: '2026-08-31', limite_meses: 6 },
      ctx,
    );
    expect(v.vence_el).toBe('2027-02-28');
  });

  it('la fecha EXACTA manda sobre instalación + meses', () => {
    const v = vidaDeComponente(
      { ...base, limite_meses: 12, fecha_vencimiento: '2026-12-01' },
      ctx,
    );
    expect(v.vence_el).toBe('2026-12-01');
    expect(v.dias_restantes).toBe(14);
    expect(v.estado).toBe('POR_VENCER');
  });

  it('la fecha exacta no necesita fecha de instalación', () => {
    const v = vidaDeComponente(
      { ...base, fecha_instalacion: null, fecha_vencimiento: '2027-01-01' },
      ctx,
    );
    expect(v.estado).toBe('VIGENTE');
    expect(v.dias_en_servicio).toBeNull();
    expect(v.faltantes).toEqual([]);
  });

  it('meses sin fecha de instalación ⇒ SIN_DATOS y lo dice', () => {
    expect(
      vidaDeComponente(
        { ...base, fecha_instalacion: null, limite_meses: 12 },
        ctx,
      ),
    ).toMatchObject({
      vence_el: null,
      dias_restantes: null,
      estado: 'SIN_DATOS',
      por: 'FECHA',
      faltantes: ['fecha_instalacion'],
    });
  });

  it('aviso de días por omisión cuando viene null', () => {
    const v = vidaDeComponente(
      {
        ...base,
        aviso_dias: null,
        fecha_vencimiento: sumarDias(HOY, AVISO_DIAS_DEFAULT),
      },
      ctx,
    );
    expect(v.dias_restantes).toBe(AVISO_DIAS_DEFAULT);
    expect(v.estado).toBe('POR_VENCER');
  });

  it('aviso en 0: el día que vence sigue avisando; un día antes, vigente', () => {
    const c = { ...base, aviso_dias: 0 };
    expect(vidaDeComponente({ ...c, fecha_vencimiento: HOY }, ctx).estado).toBe(
      'POR_VENCER',
    );
    expect(
      vidaDeComponente({ ...c, fecha_vencimiento: '2026-11-18' }, ctx).estado,
    ).toBe('VIGENTE');
  });

  it('el día de HOY entra por parámetro: el mismo componente, otro día', () => {
    const c = { ...base, fecha_vencimiento: '2026-12-01' };
    expect(
      vidaDeComponente(c, { hoy: '2026-10-01', horasAeronave: HOBBS }),
    ).toMatchObject({ dias_restantes: 61, estado: 'VIGENTE' });
    expect(
      vidaDeComponente(c, { hoy: '2026-12-02', horasAeronave: HOBBS }),
    ).toMatchObject({ dias_restantes: -1, estado: 'VENCIDO' });
  });

  it('fecha de instalación a futuro ⇒ 0 días en servicio (nunca negativo)', () => {
    const v = vidaDeComponente(
      { ...base, fecha_instalacion: '2026-12-01' },
      ctx,
    );
    expect(v.dias_en_servicio).toBe(0);
  });
});

describe('vidaDeComponente — las dos dimensiones: manda la PEOR', () => {
  const c = { ...base, limite_horas: 500, limite_meses: 12 };

  it('las dos vigentes ⇒ VIGENTE (empate ⇒ HORAS)', () => {
    const v = vidaDeComponente(c, ctx);
    expect(v).toMatchObject({
      horas_restantes: 400.6,
      vence_el: '2027-09-01',
      dias_restantes: 288,
      estado: 'VIGENTE',
      por: 'HORAS',
    });
  });

  it('horas vigentes y fecha vencida ⇒ VENCIDO por FECHA', () => {
    const v = vidaDeComponente({ ...c, fecha_vencimiento: '2026-11-01' }, ctx);
    expect(v).toMatchObject({
      horas_restantes: 400.6,
      dias_restantes: -16,
      estado: 'VENCIDO',
      por: 'FECHA',
    });
  });

  it('horas por vencer y fecha vigente ⇒ POR_VENCER por HORAS', () => {
    const v = vidaDeComponente(c, { hoy: HOY, horasAeronave: 5995 });
    expect(v).toMatchObject({ estado: 'POR_VENCER', por: 'HORAS' });
  });

  it('las dos vencidas ⇒ VENCIDO (empate ⇒ HORAS)', () => {
    const v = vidaDeComponente(
      { ...c, fecha_vencimiento: '2026-11-01' },
      { hoy: HOY, horasAeronave: 6010 },
    );
    expect(v).toMatchObject({ estado: 'VENCIDO', por: 'HORAS' });
  });

  it('horas SIN_DATOS y fecha vigente ⇒ SIN_DATOS por HORAS (no se esconde)', () => {
    const v = vidaDeComponente({ ...c, horas_aeronave_instalacion: null }, ctx);
    expect(v).toMatchObject({
      estado: 'SIN_DATOS',
      por: 'HORAS',
      dias_restantes: 288,
      faltantes: ['horas_aeronave_instalacion'],
    });
  });

  it('horas SIN_DATOS y fecha por vencer ⇒ POR_VENCER por FECHA (lo urgente gana)', () => {
    const v = vidaDeComponente(
      {
        ...c,
        horas_aeronave_instalacion: null,
        fecha_vencimiento: '2026-11-20',
      },
      ctx,
    );
    expect(v).toMatchObject({
      estado: 'POR_VENCER',
      por: 'FECHA',
      faltantes: ['horas_aeronave_instalacion'],
    });
  });

  it('horas vigentes y fecha SIN_DATOS ⇒ SIN_DATOS por FECHA', () => {
    const v = vidaDeComponente({ ...c, fecha_instalacion: null }, ctx);
    expect(v).toMatchObject({
      estado: 'SIN_DATOS',
      por: 'FECHA',
      horas_restantes: 400.6,
      faltantes: ['fecha_instalacion'],
    });
  });
});

describe('vidaDeComponente — RETIRADO: congelado al retiro', () => {
  const retirado: DatosVidaComponente = {
    ...base,
    estado: 'RETIRADO',
    horas_previas: 20,
    limite_horas: 100,
    limite_meses: 1,
    fecha_vencimiento: '2026-10-01',
    fecha_retiro: '2026-10-15',
    horas_aeronave_retiro: 5560.5,
  };

  it('horas y días al RETIRO (no a hoy); ya no vence nada', () => {
    expect(vidaDeComponente(retirado, ctx)).toEqual({
      horas_en_servicio: 80.5, // 20 + (5560.5 − 5500), no (5599.4 − 5500)
      horas_restantes: null,
      vence_el: null,
      dias_restantes: null,
      dias_en_servicio: 44, // 1-sep → 15-oct
      estado: 'SIN_LIMITE',
      por: null,
      faltantes: [],
    });
  });

  it('no cambia aunque el avión siga volando y pasen los días', () => {
    const despues = vidaDeComponente(retirado, {
      hoy: '2028-01-01',
      horasAeronave: 9000,
    });
    expect(despues).toEqual(vidaDeComponente(retirado, ctx));
  });

  it('retirado sin Hobbs ni fecha de retiro: en servicio null, sin inventar', () => {
    const v = vidaDeComponente(
      { ...retirado, fecha_retiro: null, horas_aeronave_retiro: null },
      ctx,
    );
    expect(v.horas_en_servicio).toBeNull();
    expect(v.dias_en_servicio).toBeNull();
    expect(v.estado).toBe('SIN_LIMITE');
  });
});

describe('compararPorUrgencia — orden de la lista del avión', () => {
  const fila = (nombre: string, estado: EstadoVida) => ({
    nombre,
    vida: { estado },
  });

  it('vencido, por vencer, faltan datos, vigente, sin límite', () => {
    const lista = [
      fila('Extintor', 'SIN_LIMITE'),
      fila('Batería ELT', 'VIGENTE'),
      fila('Llanta de nariz', 'SIN_DATOS'),
      fila('Foco de taxi', 'POR_VENCER'),
      fila('Llanta principal izquierda', 'VENCIDO'),
    ].sort(compararPorUrgencia);
    expect(lista.map((x) => x.vida.estado)).toEqual([
      'VENCIDO',
      'POR_VENCER',
      'SIN_DATOS',
      'VIGENTE',
      'SIN_LIMITE',
    ]);
  });

  it('mismo estado ⇒ por nombre, sin que acentos ni mayúsculas lo desordenen', () => {
    const lista = [
      fila('llanta principal', 'VIGENTE'),
      fila('Ámbar de posición', 'VIGENTE'),
      fila('Batería ELT', 'VIGENTE'),
      fila('alternador', 'VIGENTE'),
    ].sort(compararPorUrgencia);
    expect(lista.map((x) => x.nombre)).toEqual([
      'alternador',
      'Ámbar de posición',
      'Batería ELT',
      'llanta principal',
    ]);
  });

  it('la gravedad es estrictamente creciente en el orden del contrato', () => {
    const orden: EstadoVida[] = [
      'VENCIDO',
      'POR_VENCER',
      'SIN_DATOS',
      'VIGENTE',
      'SIN_LIMITE',
    ];
    const g = orden.map(gravedadDeEstado);
    expect(g).toEqual([...g].sort((a, b) => a - b));
    expect(new Set(g).size).toBe(orden.length);
  });
});

/** Ayuda de la prueba: día + N días (calendario UTC). */
function sumarDias(dia: string, dias: number): string {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}
