-- Parte 2 de GASOLINA (separada: el valor nuevo del enum no puede usarse en
-- la misma transacción que lo crea).

-- 1) GASOLINA es repartible a mano (Otros gastos), como OTRO/FIJO/INDIRECTO.
create or replace function public.tg_gasto_reparto_valida()
returns trigger language plpgsql as $$
declare
  v_vuelo uuid;
  v_categoria text;
begin
  select vuelo_id, categoria::text into v_vuelo, v_categoria
  from public.gasto where id = new.gasto_id;
  if v_vuelo is not null then
    raise exception 'gasto_reparto: el gasto % está ligado a un vuelo — su avión se controla por el vuelo', new.gasto_id;
  end if;
  if v_categoria not in ('OTRO', 'FIJO', 'INDIRECTO', 'GASOLINA') then
    raise exception 'gasto_reparto: la categoría % no es repartible (solo OTRO/FIJO/INDIRECTO/GASOLINA)', v_categoria;
  end if;
  return new;
end $$;

-- 2) Reclasificación de las 10 cargas de gasolina de AUTOS capturadas como
--    GAS (revisión 26-ago aprobada por el cliente): gasolineras Pemex/Gulf,
--    Magna/Premium/Regular a $25-29/L, capturas de oficina con nombre de la
--    persona (YANI/ALE/PABLO). Quedan como gasto de la EMPRESA: sin avión y
--    sin vuelo. Los WHERE fijan el estado actual: si ya se corrigió, no-op.

-- 8 sin avión ni vuelo (solo cambia la categoría)
update gasto set categoria = 'GASOLINA'
 where categoria = 'GAS' and aeronave_id is null and vuelo_id is null
   and id in (
     '9d709df7-c152-4f03-b3eb-ccb2253a5811', -- 01-ago YANI Regular $900.00
     '8beaa1e7-9a3b-4cf0-868b-13b3cf11c8cd', -- 01-ago ALE Magna $1,580.26
     '2dad3691-07d9-4e48-b872-b548dc284d89', -- 03-ago PABLO Magna $800.03
     'b6aab812-34b2-4263-a699-3a3f5e69ec14', -- 04-ago YANI Premium $1,200.00
     'e9ba4cfe-5939-4172-8e97-bcb825e0ef3d', -- 04-ago ALE Premium $1,366.85
     'cdef409b-96ae-4981-990c-18597686aa98', -- 08-ago Ale Gulf Regular $840.21
     'f3b2bb23-418d-4cb1-b461-b97a04e5eaaa', -- 13-ago Ale Magna $842.09
     '4a7b8be7-5057-45fb-aa47-30b1a656e150'  -- 22-ago Pablo Regular $797.02
   );

-- Pemex Magna "envío de paquetería" que contaminaba el balance de XB-ANU
update gasto set categoria = 'GASOLINA', aeronave_id = null
 where id = '264b5aec-b57e-4a07-b9d7-9b9358cbe359'
   and categoria = 'GAS' and vuelo_id is null;

-- $250 en efectivo "gasolina" ligada al vuelo #119/N990GG: monto de
-- gasolinera, no de avgas (confirmado con el cliente: es de auto)
update gasto set categoria = 'GASOLINA', aeronave_id = null, vuelo_id = null
 where id = 'e9cac19f-c162-425b-81e8-95067a458425'
   and categoria = 'GAS';
