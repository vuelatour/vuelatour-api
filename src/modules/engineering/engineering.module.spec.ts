// ARRANQUE de EngineeringModule (17-nov-2026, API 0.0.140, invariante 135):
// que Nest RESUELVA la inyección de sus proveedores con lo que le exportan
// sus imports. Los módulos importados y sus servicios van como DOBLES (los
// reales arrastran googleapis, firebase y el gateway con `jose` en ESM, que
// jest no transforma); lo que exportan los reales se congela leyendo su
// FUENTE, como en `flights.module.spec`.
jest.mock('../supabase/supabase.service', () => ({
  SupabaseService: class SupabaseService {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class CalendarSyncService {},
}));
jest.mock('../configuracion/configuracion.service', () => ({
  ConfiguracionService: class ConfiguracionService {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class AircraftService {},
}));
jest.mock('../calendar/calendar.module', () => ({
  CalendarModule: class CalendarModule {},
}));
jest.mock('../configuracion/configuracion.module', () => ({
  ConfiguracionModule: class ConfiguracionModule {},
}));
jest.mock('../aircraft/aircraft.module', () => ({
  AircraftModule: class AircraftModule {},
}));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AircraftModule } from '../aircraft/aircraft.module';
import { AircraftService } from '../aircraft/aircraft.service';
import { CalendarModule } from '../calendar/calendar.module';
import { CalendarSyncService } from '../calendar/calendar-sync.service';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AdjuntosIngenieriaService } from './adjuntos-ingenieria.service';
import { ComponentesService } from './componentes.service';
import { EngineeringController } from './engineering.controller';
import { EngineeringModule } from './engineering.module';
import { EngineeringService } from './engineering.service';

const supabaseDoble = {
  service: { from: jest.fn(), storage: { from: jest.fn() } },
};
const aircraftDoble = { currentHobbs: jest.fn().mockResolvedValue(5599.4) };
const calendarSyncDoble = { syncMantenimiento: jest.fn() };
const configuracionDoble = {};

/** SupabaseModule es @Global en la app: aquí, su doble. */
@Global()
@Module({
  providers: [{ provide: SupabaseService, useValue: supabaseDoble }],
  exports: [SupabaseService],
})
class SupabaseDobleModule {}

@Module({
  providers: [{ provide: CalendarSyncService, useValue: calendarSyncDoble }],
  exports: [CalendarSyncService],
})
class CalendarDobleModule {}

@Module({
  providers: [{ provide: ConfiguracionService, useValue: configuracionDoble }],
  exports: [ConfiguracionService],
})
class ConfiguracionDobleModule {}

@Module({
  providers: [{ provide: AircraftService, useValue: aircraftDoble }],
  exports: [AircraftService],
})
class AircraftDobleModule {}

/** Lo que Nest inyectó en un campo (privado) del servicio. */
const inyectado = (servicio: object, campo: string): unknown =>
  (servicio as Record<string, unknown>)[campo];

/** Compila el EngineeringModule REAL con sus imports sustituidos por dobles. */
function compilar(opciones: { conAircraft: boolean }) {
  let constructor = Test.createTestingModule({
    imports: [SupabaseDobleModule, EngineeringModule],
  })
    .overrideModule(CalendarModule)
    .useModule(CalendarDobleModule)
    .overrideModule(ConfiguracionModule)
    .useModule(ConfiguracionDobleModule);
  if (opciones.conAircraft) {
    constructor = constructor
      .overrideModule(AircraftModule)
      .useModule(AircraftDobleModule);
  }
  return constructor.compile();
}

describe('EngineeringModule — arranque (inyección)', () => {
  it('Nest resuelve el controlador y los tres servicios', async () => {
    const modulo = await compilar({ conAircraft: true });
    expect(modulo.get(EngineeringController)).toBeInstanceOf(
      EngineeringController,
    );
    expect(modulo.get(EngineeringService)).toBeInstanceOf(EngineeringService);
    expect(modulo.get(ComponentesService)).toBeInstanceOf(ComponentesService);
    expect(modulo.get(AdjuntosIngenieriaService)).toBeInstanceOf(
      AdjuntosIngenieriaService,
    );
    await modulo.close();
  });

  it('ComponentesService recibe el AircraftService que exporta AircraftModule (su Hobbs es el de la ficha)', async () => {
    const modulo = await compilar({ conAircraft: true });
    const componentes = modulo.get(ComponentesService);
    expect(inyectado(componentes, 'aircraft')).toBe(aircraftDoble);
    expect(inyectado(componentes, 'supabase')).toBe(supabaseDoble);
    const adjuntos = modulo.get(AdjuntosIngenieriaService);
    expect(inyectado(adjuntos, 'supabase')).toBe(supabaseDoble);
    await modulo.close();
  });

  it('sin el AircraftService de AircraftModule el módulo NO arranca (la prueba sí detecta un import que falte)', async () => {
    await expect(compilar({ conAircraft: false })).rejects.toThrow(
      /ComponentesService/,
    );
  });
});

describe('EngineeringModule — imports y ciclo (fuente)', () => {
  const leer = (rel: string) =>
    readFileSync(path.resolve(__dirname, rel), 'utf8');
  const fuente = leer('engineering.module.ts');
  const bloqueImports = /imports:\s*\[([\s\S]*?)\],\s*controllers:/.exec(
    fuente,
  );

  it('importa AircraftModule (el Hobbs de los componentes es `currentHobbs`)', () => {
    expect(fuente).toContain(
      "import { AircraftModule } from '../aircraft/aircraft.module';",
    );
    expect(bloqueImports).not.toBeNull();
    const importados = (bloqueImports?.[1] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    expect(importados).toEqual([
      'CalendarModule',
      'ConfiguracionModule',
      'AircraftModule',
    ]);
    // Sin forwardRef: no hay ciclo que romper.
    expect(fuente).not.toContain('forwardRef');
  });

  it('AircraftModule exporta AircraftService', () => {
    expect(leer('../aircraft/aircraft.module.ts')).toMatch(
      /exports:\s*\[[^\]]*\bAircraftService\b[^\]]*\]/,
    );
  });

  it('SIN CICLO: fuera de AppModule, ningún módulo importa EngineeringModule', () => {
    const raiz = path.resolve(__dirname, '..');
    const modulos: string[] = [];
    const recorrer = (dir: string) => {
      for (const nombre of readdirSync(dir)) {
        const ruta = path.join(dir, nombre);
        if (statSync(ruta).isDirectory()) recorrer(ruta);
        else if (nombre.endsWith('.module.ts')) modulos.push(ruta);
      }
    };
    recorrer(raiz);
    // Sanidad: el recorrido sí encuentra los módulos del API.
    expect(modulos.length).toBeGreaterThan(20);
    const quienesLoImportan = modulos
      .filter((ruta) => path.basename(ruta) !== 'engineering.module.ts')
      .filter((ruta) =>
        readFileSync(ruta, 'utf8').includes('EngineeringModule'),
      )
      .map((ruta) => path.relative(raiz, ruta));
    expect(quienesLoImportan).toEqual([]);
    // AppModule sí lo registra (si no, las rutas no existirían).
    expect(leer('../../app.module.ts')).toContain('EngineeringModule,');
  });
});
