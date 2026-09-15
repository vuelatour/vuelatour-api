-- 16-sep-2026 · Desglose del auto-cruce en el job de importación.
--
-- CONTEXTO: el 15-sep la importación del estado de cuenta murió al 37 %
-- (job 4f9545e3) porque UN error de trigger tumbaba el job entero; los 101
-- movimientos quedaron insertados y sin conciliar y el panel solo mostraba
-- «ERROR». Desde el API 0.0.13 ningún movimiento puede tumbar el job: cada
-- uno se cuenta con su resultado (conciliado / traspaso / ambiguo / sin
-- candidato / rechazado / error) y el job termina LISTO diciendo cuántos y
-- por qué. Estas columnas guardan ese desglose para que el operador lo vea
-- DESPUÉS de que el toast desaparezca.
--
-- TODO ADITIVO Y RETROCOMPATIBLE: el API escribe estas columnas en un
-- UPDATE aparte y, si no existen todavía, reintenta sin ellas (el job se
-- cierra igual). Aplicarla solo mejora lo que se ve en el panel.
--
-- SIN TRIGGERS: nada que probar en seco. (Recordatorio de la lección del
-- 15-sep: `moneda` es un ENUM `public.moneda` en gasto/cuenta_bancaria/
-- cobro_vuelo — en plpgsql SIEMPRE se compara `::text`, y toda migración
-- con trigger se prueba con un UPDATE REAL dentro de begin/rollback.)

alter table public.conciliacion_import_job
  add column if not exists errores int not null default 0,
  add column if not exists errores_detalle jsonb,
  add column if not exists resultados jsonb,
  -- 'IMPORT' (subir un estado de cuenta) | 'RECRUCE' (volver a cruzar lo
  -- pendiente). Hoy el re-cruce responde en línea; la columna deja la
  -- puerta abierta a correrlo como job sin otra migración.
  add column if not exists tipo text not null default 'IMPORT';

comment on column public.conciliacion_import_job.errores is
  'Movimientos cuyo auto-cruce falló (NO tumban el job: se cuentan y se sigue).';
comment on column public.conciliacion_import_job.errores_detalle is
  'Hasta 100 filas [{movimiento_id, resultado, criterio, motivo, candidatos_n}] con el porqué de lo que no se concilió.';
comment on column public.conciliacion_import_job.resultados is
  'Desglose {conciliados, traspasos, ambiguos, sin_candidato, rechazados, errores, por_criterio{MONTO_EXACTO|TARJETA|DESCRIPCION|FALTANTE|TC_IMPLICITO|REGLA}}.';
comment on column public.conciliacion_import_job.tipo is
  'IMPORT = importación de un estado de cuenta; RECRUCE = re-cruce de pendientes.';
